"""
Integration Endpoints
Google OAuth callback + disconnect — one unified connection covering
Calendar + Sheets + Drive together, using each clinic's own OAuth client
(BYOK, not a platform-shared app).
"""

import os
import json
import logging

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from shared.security import require_internal_secret

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/google/auth")
async def google_auth_start(tenant_id: str):
    from shared.google_integrations import get_google_oauth_url
    try:
        oauth_url = await get_google_oauth_url(tenant_id)
    except RuntimeError as e:
        frontend_url = (os.getenv("FRONTEND_URL") or "https://project222-livid.vercel.app").strip().rstrip("/")
        return RedirectResponse(url=f"{frontend_url}/settings/plugins/google?error={e}")
    return RedirectResponse(url=oauth_url)


@router.get("/google/callback")
async def google_oauth_callback(request: Request):
    """
    Legacy callback — kept for backwards compatibility.
    New flow uses /api/integrations/google/exchange via the Next.js proxy callback.
    """
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    error = request.query_params.get("error")

    frontend_url = (os.getenv("FRONTEND_URL") or "https://project222-livid.vercel.app").strip().rstrip("/")
    google_page = f"{frontend_url}/settings/plugins/google"

    if error:
        return RedirectResponse(url=f"{google_page}?error={error}")

    if not code or not state:
        return RedirectResponse(url=f"{google_page}?error=missing_params")

    try:
        state_data = json.loads(state)
        tenant_id = state_data["tenant_id"]
    except Exception:
        return RedirectResponse(url=f"{google_page}?error=invalid_state")

    try:
        access_token, refresh_token = await _exchange_google_code(tenant_id, code)
    except Exception as e:
        err_str = str(e)
        logger.error(f"[Google OAuth] Token exchange failed for tenant {tenant_id}: {err_str}")
        # Surface the actual Google error in the redirect so we can debug
        import urllib.parse
        return RedirectResponse(url=f"{google_page}?error={urllib.parse.quote(err_str[:120])}")

    if not access_token:
        return RedirectResponse(url=f"{google_page}?error=token_exchange_failed")

    try:
        await _complete_google_connection(tenant_id, access_token, refresh_token)
    except Exception as e:
        logger.error(f"[Google OAuth] Failed to store tokens for tenant {tenant_id}: {e}")
        return RedirectResponse(url=f"{google_page}?error=storage_failed")

    return RedirectResponse(url=f"{google_page}?success=true")


class ExchangeRequest(BaseModel):
    code: str
    state: str


@router.post("/google/exchange", dependencies=[Depends(require_internal_secret)])
async def google_exchange(req: ExchangeRequest):
    """
    New endpoint: Next.js callback proxy calls this to exchange code for tokens.
    Returns JSON so Next.js controls the final redirect (always correct origin).
    """
    try:
        state_data = json.loads(req.state)
        tenant_id = state_data["tenant_id"]
    except Exception:
        raise HTTPException(status_code=400, detail="invalid_state")

    try:
        access_token, refresh_token = await _exchange_google_code(tenant_id, req.code)
    except Exception as e:
        logger.error(f"[Google OAuth] Token exchange failed for tenant {tenant_id}: {e}")
        raise HTTPException(status_code=400, detail=f"token_exchange_failed: {str(e)}")

    if not access_token:
        raise HTTPException(status_code=400, detail="token_exchange_failed: no access token")

    try:
        await _complete_google_connection(tenant_id, access_token, refresh_token)
    except Exception as e:
        logger.error(f"[Google OAuth] Failed to store tokens for tenant {tenant_id}: {e}")
        raise HTTPException(status_code=500, detail="storage_failed")

    return {"success": True, "tenant_id": tenant_id}


async def _complete_google_connection(tenant_id: str, access_token: str, refresh_token: str):
    """
    One connection now covers both Calendar ('primary' calendar) and Sheets
    (a spreadsheet auto-provisioned right here, rather than making the
    clinic paste a URL/ID) since both scopes are always requested together.
    """
    from shared.google_integrations import store_google_tokens, create_patient_spreadsheet
    from shared.tenant_config import get_supabase_client, _db_optional

    supabase = get_supabase_client()
    tenant_res = await _db_optional(lambda: supabase.table("tenants").select("name").eq(
        "id", tenant_id
    ).maybe_single().execute())
    clinic_name = (tenant_res.data or {}).get("name") or "Clinic"

    spreadsheet_id = None
    try:
        spreadsheet_id = await create_patient_spreadsheet(clinic_name, access_token)
    except Exception as e:
        logger.error(f"[Google OAuth] Spreadsheet auto-creation failed for tenant {tenant_id}: {e}")
        # Still store the tokens — the clinic is connected even if sheet
        # creation failed; log_lead() will just no-op with no sheet ID
        # until this is retried (e.g. by disconnecting and reconnecting).

    await store_google_tokens(
        tenant_id=tenant_id,
        access_token=access_token,
        refresh_token=refresh_token,
        calendar_id="primary",
        spreadsheet_id=spreadsheet_id,
    )


@router.post("/google/disconnect", dependencies=[Depends(require_internal_secret)])
async def google_disconnect(request: Request):
    body = await request.json()
    tenant_id = body.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required")

    from shared.tenant_config import get_supabase_client, _db
    supabase = get_supabase_client()

    await _db(lambda: supabase.table("tenant_settings").update({
        "google_access_token": None,
        "google_refresh_token": None,
        "google_calendar_id": None,
        "google_sheets_id": None,
    }).eq("tenant_id", tenant_id).execute())
    return {"success": True}


async def _exchange_google_code(tenant_id: str, code: str):
    import httpx
    from shared.tenant_config import get_tenant_by_id
    from shared.providers import _cred

    tenant = await get_tenant_by_id(tenant_id)
    client_id = tenant and _cred(tenant, "google", "client_id")
    client_secret = tenant and _cred(tenant, "google", "client_secret")
    if not client_id or not client_secret:
        raise Exception("Google OAuth client not configured — save your Client ID and Secret first")

    backend_url = (os.getenv("BACKEND_URL") or "").strip().rstrip("/")
    redirect_uri = f"{backend_url}/api/integrations/google/callback"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        if response.status_code != 200:
            raise Exception(f"Token exchange failed ({response.status_code}): {response.text[:300]}")
        tokens = response.json()

    return tokens.get("access_token"), tokens.get("refresh_token")

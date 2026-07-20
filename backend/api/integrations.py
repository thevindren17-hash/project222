"""
Integration Endpoints
Google Calendar and Sheets OAuth callbacks + disconnect endpoints.
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
async def google_auth_start(tenant_id: str, service: str):
    from shared.google_integrations import get_google_oauth_url
    oauth_url = await get_google_oauth_url(tenant_id, service)
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
    calendar_page = f"{frontend_url}/settings/plugins/calendar" if frontend_url else None

    if error:
        url = f"{calendar_page}?error={error}" if calendar_page else f"/?error={error}"
        return RedirectResponse(url=url)

    if not code or not state:
        url = f"{calendar_page}?error=missing_params" if calendar_page else "/?error=missing_params"
        return RedirectResponse(url=url)

    try:
        state_data = json.loads(state)
        tenant_id = state_data["tenant_id"]
        service = state_data["service"]
    except Exception:
        url = f"{calendar_page}?error=invalid_state" if calendar_page else "/?error=invalid_state"
        return RedirectResponse(url=url)

    try:
        access_token, refresh_token = await _exchange_google_code(code)
    except Exception as e:
        err_str = str(e)
        logger.error(f"[Google OAuth] Token exchange failed for tenant {tenant_id}: {err_str}")
        # Surface the actual Google error in the redirect so we can debug
        import urllib.parse
        url = f"{calendar_page}?error={urllib.parse.quote(err_str[:120])}" if calendar_page else "/?error=token_exchange_failed"
        return RedirectResponse(url=url)

    if not access_token:
        url = f"{calendar_page}?error=token_exchange_failed" if calendar_page else "/?error=token_exchange_failed"
        return RedirectResponse(url=url)

    try:
        from shared.google_integrations import store_google_tokens
        await store_google_tokens(
            tenant_id=tenant_id,
            service=service,
            access_token=access_token,
            refresh_token=refresh_token,
            calendar_id="primary" if service == "calendar" else None,
        )
    except Exception as e:
        logger.error(f"[Google OAuth] Failed to store tokens for tenant {tenant_id}: {e}")
        url = f"{calendar_page}?error=storage_failed" if calendar_page else "/?error=storage_failed"
        return RedirectResponse(url=url)

    url = f"{calendar_page}?success=true" if calendar_page else "/?success=true"
    return RedirectResponse(url=url)


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
        service = state_data["service"]
    except Exception:
        raise HTTPException(status_code=400, detail="invalid_state")

    try:
        access_token, refresh_token = await _exchange_google_code(req.code)
    except Exception as e:
        logger.error(f"[Google OAuth] Token exchange failed for tenant {tenant_id}: {e}")
        raise HTTPException(status_code=400, detail=f"token_exchange_failed: {str(e)}")

    if not access_token:
        raise HTTPException(status_code=400, detail="token_exchange_failed: no access token")

    try:
        from shared.google_integrations import store_google_tokens
        await store_google_tokens(
            tenant_id=tenant_id,
            service=service,
            access_token=access_token,
            refresh_token=refresh_token,
            calendar_id="primary" if service == "calendar" else None,
        )
    except Exception as e:
        logger.error(f"[Google OAuth] Failed to store tokens for tenant {tenant_id}: {e}")
        raise HTTPException(status_code=500, detail="storage_failed")

    return {"success": True, "service": service, "tenant_id": tenant_id}


@router.post("/google/disconnect", dependencies=[Depends(require_internal_secret)])
async def google_disconnect(request: Request):
    body = await request.json()
    tenant_id = body.get("tenant_id")
    service = body.get("service")

    if not tenant_id or not service:
        raise HTTPException(status_code=400, detail="tenant_id and service are required")

    from shared.tenant_config import get_supabase_client
    supabase = get_supabase_client()

    if service == "calendar":
        update_data = {
            "google_calendar_token": None,
            "google_calendar_refresh": None,
            "google_calendar_id": None,
        }
    elif service == "sheets":
        update_data = {
            "google_sheets_token": None,
            "google_sheets_refresh": None,
            "google_sheets_id": None,
        }
    else:
        raise HTTPException(status_code=400, detail="Invalid service. Use 'calendar' or 'sheets'.")

    supabase.table("tenant_settings").update(update_data).eq("tenant_id", tenant_id).execute()
    return {"success": True, "service": service}


async def _exchange_google_code(code: str):
    import httpx

    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
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

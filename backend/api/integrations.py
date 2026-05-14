"""
Integration Endpoints
Google Calendar and Sheets OAuth callbacks + disconnect endpoints.
"""

import os
import json

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import RedirectResponse

router = APIRouter()


@router.get("/google/auth")
async def google_auth_start(tenant_id: str, service: str):
    from shared.google_integrations import get_google_oauth_url
    oauth_url = await get_google_oauth_url(tenant_id, service)
    return RedirectResponse(url=oauth_url)


@router.get("/google/callback")
async def google_oauth_callback(request: Request):
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    error = request.query_params.get("error")

    frontend_url = (os.getenv("FRONTEND_URL") or "").strip()
    calendar_page = f"{frontend_url}/settings/plugins/calendar"

    if error:
        return RedirectResponse(url=f"{calendar_page}?error={error}")

    if not code or not state:
        return RedirectResponse(url=f"{calendar_page}?error=missing_params")

    try:
        state_data = json.loads(state)
        tenant_id = state_data["tenant_id"]
        service = state_data["service"]
    except Exception:
        return RedirectResponse(url=f"{calendar_page}?error=invalid_state")

    try:
        access_token, refresh_token = await _exchange_google_code(code)
    except Exception as e:
        return RedirectResponse(url=f"{calendar_page}?error=token_exchange_failed")

    from shared.google_integrations import store_google_tokens
    await store_google_tokens(
        tenant_id=tenant_id,
        service=service,
        access_token=access_token,
        refresh_token=refresh_token,
    )

    return RedirectResponse(url=f"{calendar_page}?success=true&service={service}")


@router.post("/google/disconnect")
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
    backend_url = (os.getenv("BACKEND_URL") or "").strip()
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
            raise Exception(f"Token exchange failed: {response.text[:200]}")
        tokens = response.json()

    return tokens.get("access_token"), tokens.get("refresh_token")

"""
Google Integrations — Calendar and Sheets
Clinics connect their own Google account via OAuth to sync appointments and track leads.
"""

import os
import json
import logging
import httpx
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

GCAL_API = "https://www.googleapis.com/calendar/v3"


class GoogleCalendarIntegration:
    """Manage clinic's Google Calendar for appointment syncing."""

    def __init__(self, tenant_id: str, calendar_id: Optional[str] = "primary"):
        self.tenant_id = tenant_id
        self.calendar_id = calendar_id or "primary"

    async def _get_token(self) -> str:
        from shared.tenant_config import get_supabase_client, _db_optional
        supabase = get_supabase_client()
        result = await _db_optional(lambda: supabase.table("tenant_settings")
            .select("google_calendar_token,google_calendar_refresh")
            .eq("tenant_id", self.tenant_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise RuntimeError("No Google Calendar credentials found")

        token = result.data.get("google_calendar_token")
        refresh = result.data.get("google_calendar_refresh")

        if not token and not refresh:
            raise RuntimeError("Google Calendar not connected")

        if refresh:
            token = await self._refresh_token(refresh)

        return token

    async def _refresh_token(self, refresh_token: str) -> str:
        client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
        client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
        async with httpx.AsyncClient() as client:
            r = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "refresh_token": refresh_token,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "grant_type": "refresh_token",
                },
            )
        if r.status_code != 200:
            raise RuntimeError(f"Token refresh failed: {r.text[:200]}")
        new_token = r.json().get("access_token")
        if not new_token:
            raise RuntimeError("Token refresh returned no access_token")

        from shared.tenant_config import get_supabase_client, _db
        supabase = get_supabase_client()
        await _db(lambda: supabase.table("tenant_settings").update(
            {"google_calendar_token": new_token}
        ).eq("tenant_id", self.tenant_id).execute())

        return new_token

    async def create_appointment(
        self,
        summary: str,
        start_time: datetime,
        end_time: datetime,
        patient_name: str,
        patient_phone: str,
        service_type: str,
        notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        token = await self._get_token()
        event = {
            "summary": summary,
            "description": (
                f"Patient: {patient_name}\n"
                f"Phone: {patient_phone}\n"
                f"Service: {service_type}"
                + (f"\nNotes: {notes}" if notes else "")
                + "\n\n---\nCreated by AI Receptionist"
            ),
            "start": {
                "dateTime": start_time.isoformat(),
                "timeZone": "Asia/Kuala_Lumpur",
            },
            "end": {
                "dateTime": end_time.isoformat(),
                "timeZone": "Asia/Kuala_Lumpur",
            },
            "reminders": {
                "useDefault": False,
                "overrides": [
                    {"method": "popup", "minutes": 24 * 60},
                    {"method": "popup", "minutes": 60},
                ],
            },
        }
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{GCAL_API}/calendars/{self.calendar_id}/events",
                    headers={"Authorization": f"Bearer {token}"},
                    json=event,
                )
            if r.status_code not in (200, 201):
                return {"success": False, "error": r.text[:200]}
            result = r.json()
            return {
                "success": True,
                "event_id": result.get("id"),
                "link": result.get("htmlLink"),
                "status": result.get("status"),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def list_appointments(self, date: datetime, days_ahead: int = 7) -> List[Dict[str, Any]]:
        token = await self._get_token()
        time_min = date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat() + "Z"
        time_max = (date + timedelta(days=days_ahead)).isoformat() + "Z"
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    f"{GCAL_API}/calendars/{self.calendar_id}/events",
                    headers={"Authorization": f"Bearer {token}"},
                    params={
                        "timeMin": time_min,
                        "timeMax": time_max,
                        "singleEvents": "true",
                        "orderBy": "startTime",
                    },
                )
            return r.json().get("items", []) if r.status_code == 200 else []
        except Exception as e:
            logger.error(f"Error listing calendar events: {e}")
            return []

    async def find_free_slots(
        self,
        date: datetime,
        duration_minutes: int = 30,
        business_hours: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, datetime]]:
        if not business_hours:
            business_hours = {"open": "09:00", "close": "18:00"}
        if business_hours.get("closed"):
            return []

        token = await self._get_token()
        day_start = date.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = date.replace(hour=23, minute=59, second=59, microsecond=0)

        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{GCAL_API}/freeBusy",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "timeMin": day_start.isoformat() + "Z",
                        "timeMax": day_end.isoformat() + "Z",
                        "items": [{"id": self.calendar_id}],
                    },
                )
            busy_blocks = []
            if r.status_code == 200:
                cal_data = r.json().get("calendars", {}).get(self.calendar_id, {})
                busy_blocks = [
                    (
                        datetime.fromisoformat(b["start"].replace("Z", "+00:00")).replace(tzinfo=None),
                        datetime.fromisoformat(b["end"].replace("Z", "+00:00")).replace(tzinfo=None),
                    )
                    for b in cal_data.get("busy", [])
                ]
        except Exception as e:
            logger.error(f"Error fetching freebusy: {e}")
            busy_blocks = []

        # Generate slots within business hours, skipping busy blocks
        open_h, open_m = map(int, business_hours["open"].split(":"))
        close_h, close_m = map(int, business_hours["close"].split(":"))
        current = date.replace(hour=open_h, minute=open_m, second=0, microsecond=0)
        close_dt = date.replace(hour=close_h, minute=close_m, second=0, microsecond=0)

        free_slots = []
        while current + timedelta(minutes=duration_minutes) <= close_dt:
            slot_end = current + timedelta(minutes=duration_minutes)
            overlap = any(
                not (slot_end <= b_start or current >= b_end)
                for b_start, b_end in busy_blocks
            )
            if not overlap:
                free_slots.append({"start": current, "end": slot_end})
            current += timedelta(minutes=duration_minutes)

        return free_slots

    async def update_appointment(self, event_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        token = await self._get_token()
        try:
            async with httpx.AsyncClient() as client:
                r = await client.patch(
                    f"{GCAL_API}/calendars/{self.calendar_id}/events/{event_id}",
                    headers={"Authorization": f"Bearer {token}"},
                    json=updates,
                )
            return {"success": r.status_code in (200, 201), "event": r.json()}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def delete_appointment(self, event_id: str) -> Dict[str, Any]:
        token = await self._get_token()
        try:
            async with httpx.AsyncClient() as client:
                r = await client.delete(
                    f"{GCAL_API}/calendars/{self.calendar_id}/events/{event_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            return {"success": r.status_code == 204}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _is_within_hours(self, dt: datetime, hours: Dict[str, str]) -> bool:
        time_str = dt.strftime("%H:%M")
        return hours["open"] <= time_str <= hours["close"]


SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
SHEETS_TAB_NAME = "Patients"
SHEETS_HEADER_ROW = [
    "Timestamp", "Event", "Patient Name", "Phone", "Source",
    "Service", "Notes", "Custom Fields",
]


class GoogleSheetsIntegration:
    """
    One-way mirror of patient/booking activity into a clinic's own Google
    Sheet — write-only, the app never reads back from it. Supabase stays the
    real database; this is purely a convenience copy in a format the clinic
    already knows how to use.
    """

    def __init__(self, tenant_id: str, spreadsheet_id: Optional[str] = None):
        self.tenant_id = tenant_id
        self.spreadsheet_id = spreadsheet_id

    async def _get_token(self) -> str:
        from shared.tenant_config import get_supabase_client, _db_optional
        supabase = get_supabase_client()
        result = await _db_optional(lambda: supabase.table("tenant_settings")
            .select("google_sheets_token,google_sheets_refresh")
            .eq("tenant_id", self.tenant_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise RuntimeError("No Google Sheets credentials found")

        token = result.data.get("google_sheets_token")
        refresh = result.data.get("google_sheets_refresh")

        if not token and not refresh:
            raise RuntimeError("Google Sheets not connected")

        if refresh:
            token = await self._refresh_token(refresh)

        return token

    async def _refresh_token(self, refresh_token: str) -> str:
        client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
        client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
        async with httpx.AsyncClient() as client:
            r = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "refresh_token": refresh_token,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "grant_type": "refresh_token",
                },
            )
        if r.status_code != 200:
            raise RuntimeError(f"Token refresh failed: {r.text[:200]}")
        new_token = r.json().get("access_token")
        if not new_token:
            raise RuntimeError("Token refresh returned no access_token")

        from shared.tenant_config import get_supabase_client, _db
        supabase = get_supabase_client()
        await _db(lambda: supabase.table("tenant_settings").update(
            {"google_sheets_token": new_token}
        ).eq("tenant_id", self.tenant_id).execute())

        return new_token

    async def log_lead(
        self,
        name: str,
        phone: str,
        source: str,
        status: str,
        notes: Optional[str] = None,
        service_interest: Optional[str] = None,
        custom_fields: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        if not self.spreadsheet_id:
            return {"success": False, "error": "No spreadsheet configured"}
        custom_fields_str = "; ".join(f"{k}: {v}" for k, v in (custom_fields or {}).items())
        row_data = [
            datetime.now().isoformat(),
            status,
            name,
            phone,
            source,
            service_interest or "",
            notes or "",
            custom_fields_str,
        ]
        try:
            await self._append_row(row_data)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _append_row(self, row_data: List[str]):
        token = await self._get_token()
        range_ = f"{SHEETS_TAB_NAME}!A:H"
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{SHEETS_API}/{self.spreadsheet_id}/values/{range_}:append",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                json={"values": [row_data]},
            )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Sheets append failed ({r.status_code}): {r.text[:200]}")
        return r.json()


# ── OAuth helpers ──────────────────────────────────────────────────────────────

async def get_google_oauth_url(tenant_id: str, service: str) -> str:
    """Generate OAuth URL for clinic to authorize Google Calendar/Sheets access."""
    backend_url = (os.getenv("BACKEND_URL") or "").strip().rstrip("/")
    redirect_uri = f"{backend_url}/api/integrations/google/callback"
    state = json.dumps({"tenant_id": tenant_id, "service": service})
    scopes = {
        "calendar": "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
        "sheets": "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    }
    scope = scopes.get(service, scopes["calendar"])
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    import urllib.parse
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scope,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{params}"


async def store_google_tokens(
    tenant_id: str,
    service: str,
    access_token: str,
    refresh_token: str,
    calendar_id: Optional[str] = None,
    spreadsheet_id: Optional[str] = None,
):
    """Store Google OAuth tokens in Supabase tenant_settings."""
    from shared.tenant_config import get_supabase_client

    supabase = get_supabase_client()
    update_data: Dict[str, Any] = {}

    if service == "calendar":
        update_data["google_calendar_token"] = access_token
        if refresh_token:  # never overwrite an existing refresh_token with None
            update_data["google_calendar_refresh"] = refresh_token
        if calendar_id:
            update_data["google_calendar_id"] = calendar_id
    elif service == "sheets":
        update_data["google_sheets_token"] = access_token
        if refresh_token:
            update_data["google_sheets_refresh"] = refresh_token
        if spreadsheet_id:
            update_data["google_sheets_id"] = spreadsheet_id

    from shared.tenant_config import _db
    await _db(lambda: supabase.table("tenant_settings").update(update_data).eq("tenant_id", tenant_id).execute())


async def create_patient_spreadsheet(clinic_name: str, access_token: str) -> str:
    """
    Auto-provision a new Google Sheet for a clinic right after they connect
    Sheets — avoids making them paste a spreadsheet URL/ID (error-prone) and
    guarantees the header row matches what log_lead() writes.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        create_res = await client.post(
            SHEETS_API,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json={
                "properties": {"title": f"{clinic_name} — Patient Bookings (YourReceiptionist)"},
                "sheets": [{"properties": {"title": SHEETS_TAB_NAME}}],
            },
        )
        if create_res.status_code not in (200, 201):
            raise RuntimeError(f"Spreadsheet creation failed ({create_res.status_code}): {create_res.text[:200]}")
        spreadsheet_id = create_res.json()["spreadsheetId"]

        header_res = await client.put(
            f"{SHEETS_API}/{spreadsheet_id}/values/{SHEETS_TAB_NAME}!A1:H1",
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            params={"valueInputOption": "RAW"},
            json={"values": [SHEETS_HEADER_ROW]},
        )
        if header_res.status_code not in (200, 201):
            logger.warning(f"Spreadsheet header write failed (non-fatal): {header_res.text[:200]}")

    return spreadsheet_id


# ── Per-tenant instance getters ────────────────────────────────────────────────

async def get_google_calendar(tenant_id: str) -> Optional[GoogleCalendarIntegration]:
    from shared.tenant_config import get_supabase_client, _db_optional
    supabase = get_supabase_client()
    result = await _db_optional(lambda: supabase.table("tenant_settings")
        .select("google_calendar_token,google_calendar_refresh,google_calendar_id")
        .eq("tenant_id", tenant_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        return None
    has_token = result.data.get("google_calendar_token") or result.data.get("google_calendar_refresh")
    if not has_token:
        return None
    calendar_id = result.data.get("google_calendar_id") or "primary"
    return GoogleCalendarIntegration(tenant_id=tenant_id, calendar_id=calendar_id)


async def get_google_sheets(tenant_id: str) -> Optional[GoogleSheetsIntegration]:
    from shared.tenant_config import get_tenant_by_id

    tenant = await get_tenant_by_id(tenant_id)
    if tenant and tenant.google_sheets_id:
        return GoogleSheetsIntegration(tenant_id=tenant_id, spreadsheet_id=tenant.google_sheets_id)
    return None

"""
Google Integrations — Calendar and Sheets
Clinics connect their own Google account via OAuth to sync appointments and track leads.

One unified connection (not two): each clinic brings its own Google OAuth
client (client_id/client_secret, stored BYOK in provider_credentials.google —
same encrypted pattern as their LLM keys), and one "Connect Google" grant
covers Calendar + Sheets + Drive together via a single combined-scope OAuth
flow and one access/refresh token pair. Using a shared platform-wide OAuth
app doesn't scale past Google's ~100-user cap for unverified apps without
completing Google's own app verification, so BYOK per clinic sidesteps that
entirely — each clinic's app only ever has itself as a user.
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
            .select("google_access_token,google_refresh_token")
            .eq("tenant_id", self.tenant_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise RuntimeError("No Google credentials found")

        token = result.data.get("google_access_token")
        refresh = result.data.get("google_refresh_token")

        if not token and not refresh:
            raise RuntimeError("Google not connected")

        if refresh:
            token = await _refresh_google_token(self.tenant_id, refresh)

        return token

    async def _refresh_token(self, refresh_token: str) -> str:
        return await _refresh_google_token(self.tenant_id, refresh_token)

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
        buffer_minutes: int = 0,
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
            # Next slot starts after this one's duration AND the required
            # gap, not immediately back-to-back.
            current += timedelta(minutes=duration_minutes + buffer_minutes)

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
# Only used for the spreadsheet we auto-create ourselves (a blank file, so
# WE get to choose its layout). A clinic's own existing spreadsheet keeps
# whatever tab/headers they already made — see _match_header_to_field below.
SHEETS_TAB_NAME = "Patients"
SHEETS_HEADER_ROW = ["Timestamp", "Event", "Patient Name", "Phone", "Source", "Service", "Notes"]

# Recognized aliases for the built-in fields, so a clinic's own column names
# ("Date", "Client Name", "Contact No.") still get matched without them
# needing to use our exact wording. Compared against normalized headers
# (lowercased, punctuation/spaces stripped) — see _normalize_header.
_CANONICAL_FIELD_ALIASES: Dict[str, List[str]] = {
    # "date"/"datetime" intentionally mean the log row's own timestamp here,
    # not the appointment time — see "appointment_time" below for that.
    "timestamp": ["timestamp", "date", "datetime", "dateandtime", "createdat", "time"],
    "event": ["event", "status", "type"],
    "patient_name": ["name", "patientname", "patient", "fullname", "clientname"],
    "phone": ["phone", "phonenumber", "contact", "mobile", "contactnumber", "contactno"],
    "source": ["source"],
    "service": ["service", "servicetype", "treatment"],
    "notes": ["notes", "note", "remarks", "remark"],
    "appointment_time": [
        "appointmentdatetime", "appointmentdate", "appointmenttime", "appointment",
        "scheduledat", "scheduledtime", "scheduleddate",
        "bookingdate", "bookingtime", "bookingdatetime",
    ],
}


def _normalize_header(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _match_header_to_field(header: str, available: Dict[str, str]) -> Optional[str]:
    """
    Given one column header from a clinic's sheet, find which (if any) of
    the not-yet-placed values belongs there. Built-in fields match via the
    alias list above; custom fields match by their own key (normalized the
    same way a label gets slugified into a key, e.g. "Insurance Provider"
    and "insurance_provider" both normalize to "insuranceprovider").
    """
    h = _normalize_header(header)
    if not h:
        return None
    # A clinic writing "Services" instead of "Service" (or any other simple
    # plural of a recognized header) shouldn't silently fail to match.
    candidates = {h, h[:-1]} if h.endswith("s") and len(h) > 1 else {h}
    for canonical, aliases in _CANONICAL_FIELD_ALIASES.items():
        if candidates & set(aliases) and canonical in available:
            return canonical
    for key in available:
        if key not in _CANONICAL_FIELD_ALIASES and _normalize_header(key) in candidates:
            return key
    return None


class GoogleSheetsIntegration:
    """
    One-way mirror of patient/booking activity into a clinic's own Google
    Sheet — write-only, the app never reads back from it. Supabase stays the
    real database; this is purely a convenience copy in a format the clinic
    already knows how to use.
    """

    def __init__(self, tenant_id: str, spreadsheet_id: Optional[str] = None, tab_name: Optional[str] = None):
        self.tenant_id = tenant_id
        self.spreadsheet_id = spreadsheet_id
        self.tab_name = tab_name or SHEETS_TAB_NAME

    async def _get_token(self) -> str:
        from shared.tenant_config import get_supabase_client, _db_optional
        supabase = get_supabase_client()
        result = await _db_optional(lambda: supabase.table("tenant_settings")
            .select("google_access_token,google_refresh_token")
            .eq("tenant_id", self.tenant_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise RuntimeError("No Google credentials found")

        token = result.data.get("google_access_token")
        refresh = result.data.get("google_refresh_token")

        if not token and not refresh:
            raise RuntimeError("Google not connected")

        if refresh:
            token = await _refresh_google_token(self.tenant_id, refresh)

        return token

    async def _refresh_token(self, refresh_token: str) -> str:
        return await _refresh_google_token(self.tenant_id, refresh_token)

    async def log_lead(
        self,
        name: str,
        phone: str,
        source: str,
        status: str,
        notes: Optional[str] = None,
        service_interest: Optional[str] = None,
        appointment_time: Optional[str] = None,
        custom_fields: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        if not self.spreadsheet_id:
            return {"success": False, "error": "No spreadsheet configured"}
        values = {
            "timestamp": datetime.now().isoformat(),
            "event": status,
            "patient_name": name,
            "phone": phone,
            "source": source,
            "service": service_interest or "",
            "notes": notes or "",
            "appointment_time": appointment_time or "",
            **(custom_fields or {}),
        }
        try:
            await self._append_mapped_row(values)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _append_mapped_row(self, values: Dict[str, str]):
        """
        No fixed column layout — read whatever header row already exists in
        the target tab and write each value into whichever column is
        actually named for it (matched by normalized name, so "Insurance
        Provider", "insurance_provider", and "insuranceprovider" all match
        the same custom field key). Any header we have no matching value
        for is left blank; any value with no matching header is simply not
        written — nothing here ever adds, renames, or reorders a clinic's
        own columns.
        """
        token = await self._get_token()
        async with httpx.AsyncClient(timeout=15) as client:
            header_res = await client.get(
                f"{SHEETS_API}/{self.spreadsheet_id}/values/{self.tab_name}!1:1",
                headers={"Authorization": f"Bearer {token}"},
            )
            if header_res.status_code != 200:
                raise RuntimeError(f"Could not read the '{self.tab_name}' tab's header row ({header_res.status_code}): {header_res.text[:200]}")
            header_rows = header_res.json().get("values") or []
            headers = header_rows[0] if header_rows else []
            if not headers:
                raise RuntimeError(f"The '{self.tab_name}' tab has no header row yet — add your own column headers first")

            remaining = dict(values)
            row: List[str] = []
            for header in headers:
                match_key = _match_header_to_field(header, remaining)
                row.append(str(remaining.pop(match_key)) if match_key else "")

            r = await client.post(
                f"{SHEETS_API}/{self.spreadsheet_id}/values/{self.tab_name}!A1:append",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                json={"values": [row]},
            )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Sheets append failed ({r.status_code}): {r.text[:200]}")
        return r.json()


# ── OAuth helpers ──────────────────────────────────────────────────────────────
# One combined scope covers Calendar + Sheets — a clinic connects once and
# both features just work, rather than two separate OAuth grants for what's
# really one Google account. The `spreadsheets` scope alone already grants
# read/write to ANY spreadsheet the account can access (not just ones this
# app created), so a clinic can point us at an existing sheet — inventory,
# whatever they already use — just by pasting its link. No separate Drive
# scope needed for that, so we deliberately don't request one (least
# privilege — this app never needs to browse or read a clinic's Drive).
GOOGLE_OAUTH_SCOPE = (
    "https://www.googleapis.com/auth/calendar "
    "https://www.googleapis.com/auth/calendar.events "
    "https://www.googleapis.com/auth/spreadsheets"
)


async def get_google_oauth_url(tenant_id: str) -> str:
    """
    Generate the OAuth URL for a clinic to authorize Google access — using
    THAT CLINIC's own OAuth client (BYOK), not a platform-wide shared app.
    Raises if the clinic hasn't saved their client_id yet, so the caller can
    show a clear "set up your Google Client ID first" error.
    """
    from shared.tenant_config import get_tenant_by_id
    from shared.providers import _cred

    tenant = await get_tenant_by_id(tenant_id)
    client_id = tenant and _cred(tenant, "google", "client_id")
    if not client_id:
        raise RuntimeError("google_client_not_configured")

    backend_url = (os.getenv("BACKEND_URL") or "").strip().rstrip("/")
    redirect_uri = f"{backend_url}/api/integrations/google/callback"
    state = json.dumps({"tenant_id": tenant_id})
    import urllib.parse
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_OAUTH_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{params}"


async def _refresh_google_token(tenant_id: str, refresh_token: str) -> str:
    """Refresh an expired access token using THIS tenant's own OAuth client."""
    from shared.tenant_config import get_tenant_by_id, get_supabase_client, _db
    from shared.providers import _cred

    tenant = await get_tenant_by_id(tenant_id)
    client_id = tenant and _cred(tenant, "google", "client_id")
    client_secret = tenant and _cred(tenant, "google", "client_secret")
    if not client_id or not client_secret:
        raise RuntimeError("Google OAuth client not configured for this tenant")

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

    supabase = get_supabase_client()
    await _db(lambda: supabase.table("tenant_settings").update(
        {"google_access_token": new_token}
    ).eq("tenant_id", tenant_id).execute())

    return new_token


async def store_google_tokens(
    tenant_id: str,
    access_token: str,
    refresh_token: str,
    calendar_id: Optional[str] = None,
    spreadsheet_id: Optional[str] = None,
    sheets_tab: Optional[str] = None,
):
    """Store the (single, unified) Google OAuth tokens in tenant_settings."""
    from shared.tenant_config import get_supabase_client, _db

    supabase = get_supabase_client()
    update_data: Dict[str, Any] = {"google_access_token": access_token}
    if refresh_token:  # never overwrite an existing refresh_token with None
        update_data["google_refresh_token"] = refresh_token
    if calendar_id:
        update_data["google_calendar_id"] = calendar_id
    if spreadsheet_id:
        update_data["google_sheets_id"] = spreadsheet_id
    if sheets_tab:
        update_data["google_sheets_tab"] = sheets_tab

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


def parse_sheet_link(url_or_id: str) -> "tuple[Optional[str], Optional[str]]":
    """
    Accept either a bare spreadsheet ID or a full Google Sheets URL (any of
    its usual forms, including a #gid=... pointing at one specific tab) and
    return (spreadsheet_id, gid). gid is None if the link didn't include
    one (e.g. a bare ID, or a link to the first/only tab) — in that case
    the caller falls back to the spreadsheet's first tab.
    """
    import re
    s = (url_or_id or "").strip()
    if not s:
        return None, None
    gid_match = re.search(r"[#&?]gid=(\d+)", s)
    gid = gid_match.group(1) if gid_match else None
    id_match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", s)
    if id_match:
        return id_match.group(1), gid
    # Not a URL — assume they pasted the bare ID directly.
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", s):
        return s, gid
    return None, None


async def get_valid_access_token(tenant_id: str) -> str:
    """Get a live access token for this tenant, refreshing if needed — for
    operations not tied to a specific GoogleCalendarIntegration/GoogleSheetsIntegration
    instance (e.g. validating a pasted spreadsheet link before saving it)."""
    from shared.tenant_config import get_supabase_client, _db_optional
    supabase = get_supabase_client()
    result = await _db_optional(lambda: supabase.table("tenant_settings")
        .select("google_access_token,google_refresh_token")
        .eq("tenant_id", tenant_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise RuntimeError("Google not connected")
    token = result.data.get("google_access_token")
    refresh = result.data.get("google_refresh_token")
    if not token and not refresh:
        raise RuntimeError("Google not connected")
    if refresh:
        token = await _refresh_google_token(tenant_id, refresh)
    return token


async def get_spreadsheet_info(spreadsheet_id: str, access_token: str) -> Dict[str, Any]:
    """
    Confirm the connected account can actually access this spreadsheet (a
    clinic could paste a link to a sheet their Google account has no access
    to, or a mistyped ID) and return its title + every tab's name/sheetId
    (sheetId is what a pasted link's #gid= refers to).
    """
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{SHEETS_API}/{spreadsheet_id}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"fields": "properties.title,sheets.properties.title,sheets.properties.sheetId"},
        )
    if r.status_code == 404:
        raise RuntimeError("Spreadsheet not found — check the link and try again")
    if r.status_code == 403:
        raise RuntimeError("This Google account doesn't have access to that spreadsheet")
    if r.status_code != 200:
        raise RuntimeError(f"Could not open spreadsheet ({r.status_code}): {r.text[:200]}")
    data = r.json()
    return {
        "title": data.get("properties", {}).get("title", ""),
        "tabs": [
            {"title": s["properties"]["title"], "sheet_id": s["properties"]["sheetId"]}
            for s in data.get("sheets", [])
        ],
    }


async def check_tab_has_headers(spreadsheet_id: str, tab_name: str, access_token: str) -> bool:
    """
    We never create or rewrite a clinic's own header row (no fixed layout
    to impose) — just confirm one already exists before saving the
    connection, so the error surfaces now instead of on the first silent
    failed sync later.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{SHEETS_API}/{spreadsheet_id}/values/{tab_name}!1:1",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if r.status_code != 200:
        raise RuntimeError(f"Could not read the '{tab_name}' tab ({r.status_code}): {r.text[:200]}")
    rows = r.json().get("values") or []
    return bool(rows and rows[0])


# ── Per-tenant instance getters ────────────────────────────────────────────────

async def get_google_calendar(tenant_id: str) -> Optional[GoogleCalendarIntegration]:
    from shared.tenant_config import get_supabase_client, _db_optional
    supabase = get_supabase_client()
    result = await _db_optional(lambda: supabase.table("tenant_settings")
        .select("google_access_token,google_refresh_token,google_calendar_id")
        .eq("tenant_id", tenant_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        return None
    has_token = result.data.get("google_access_token") or result.data.get("google_refresh_token")
    if not has_token:
        return None
    calendar_id = result.data.get("google_calendar_id") or "primary"
    return GoogleCalendarIntegration(tenant_id=tenant_id, calendar_id=calendar_id)


async def get_google_sheets(tenant_id: str) -> Optional[GoogleSheetsIntegration]:
    from shared.tenant_config import get_tenant_by_id

    tenant = await get_tenant_by_id(tenant_id)
    if tenant and tenant.google_sheets_id:
        return GoogleSheetsIntegration(
            tenant_id=tenant_id,
            spreadsheet_id=tenant.google_sheets_id,
            tab_name=getattr(tenant, "google_sheets_tab", None),
        )
    return None

"""
Google Integrations — Calendar and Sheets
Clinics connect their own Google account via OAuth to sync appointments and track leads.
"""

import os
import json
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta


class GoogleCalendarIntegration:
    """Manage clinic's Google Calendar for appointment syncing."""

    def __init__(self, tenant_id: str, calendar_id: Optional[str] = "primary"):
        self.tenant_id = tenant_id
        self.calendar_id = calendar_id

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
        event = {
            "summary": summary,
            "description": (
                f"Patient: {patient_name}\n"
                f"Phone: {patient_phone}\n"
                f"Service: {service_type}\n"
                + (f"Notes: {notes}" if notes else "")
                + "\n\n---\nCreated by AI Receptionist"
            ).strip(),
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
            result = await self._call_mcp_tool("create_event", calendar_id=self.calendar_id, event=event)
            return {
                "success": True,
                "event_id": result.get("id"),
                "link": result.get("htmlLink"),
                "status": result.get("status"),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def list_appointments(self, date: datetime, days_ahead: int = 7) -> List[Dict[str, Any]]:
        time_min = date.isoformat()
        time_max = (date + timedelta(days=days_ahead)).isoformat()
        try:
            result = await self._call_mcp_tool(
                "list_events",
                calendar_id=self.calendar_id,
                time_min=time_min,
                time_max=time_max,
                single_events=True,
                order_by="startTime",
            )
            return result.get("items", [])
        except Exception as e:
            print(f"Error listing calendar events: {e}")
            return []

    async def find_free_slots(
        self,
        date: datetime,
        duration_minutes: int = 30,
        business_hours: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, datetime]]:
        if not business_hours:
            business_hours = {"open": "09:00", "close": "18:00"}
        try:
            result = await self._call_mcp_tool(
                "find_free_time",
                calendar_id=self.calendar_id,
                time_min=date.isoformat(),
                time_max=(date + timedelta(days=1)).isoformat(),
                duration_minutes=duration_minutes,
            )
            slots = []
            for slot in result.get("free_slots", []):
                start = datetime.fromisoformat(slot["start"])
                if self._is_within_hours(start, business_hours):
                    slots.append({"start": start, "end": datetime.fromisoformat(slot["end"])})
            return slots
        except Exception as e:
            print(f"Error finding free time: {e}")
            return []

    async def update_appointment(self, event_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        try:
            result = await self._call_mcp_tool(
                "update_event",
                calendar_id=self.calendar_id,
                event_id=event_id,
                event=updates,
            )
            return {"success": True, "event": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def delete_appointment(self, event_id: str) -> Dict[str, Any]:
        try:
            await self._call_mcp_tool("delete_event", calendar_id=self.calendar_id, event_id=event_id)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _is_within_hours(self, dt: datetime, hours: Dict[str, str]) -> bool:
        time_str = dt.strftime("%H:%M")
        return hours["open"] <= time_str <= hours["close"]

    async def _call_mcp_tool(self, tool_name: str, **kwargs):
        raise NotImplementedError(
            f"MCP tool '{tool_name}' not available. "
            "Ensure Google Calendar MCP server is configured."
        )


class GoogleSheetsIntegration:
    """Track leads and contacts in Google Sheets."""

    def __init__(self, tenant_id: str, spreadsheet_id: Optional[str] = None):
        self.tenant_id = tenant_id
        self.spreadsheet_id = spreadsheet_id

    async def log_lead(
        self,
        name: str,
        phone: str,
        source: str,
        status: str,
        notes: Optional[str] = None,
        service_interest: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self.spreadsheet_id:
            return {"success": False, "error": "No spreadsheet configured"}
        row_data = [
            datetime.now().isoformat(),
            name,
            phone,
            source,
            status,
            service_interest or "",
            notes or "",
        ]
        try:
            result = await self._append_row(row_data)
            return {"success": True, "row": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def update_lead_status(self, phone: str, new_status: str) -> Dict[str, Any]:
        try:
            result = await self._update_by_phone(phone, "Status", new_status)
            return {"success": True, "updated": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_lead_by_phone(self, phone: str) -> Optional[Dict[str, Any]]:
        try:
            row = await self._find_row_by_phone(phone)
            if row:
                return {
                    "name": row[1],
                    "phone": row[2],
                    "source": row[3],
                    "status": row[4],
                    "service_interest": row[5],
                    "notes": row[6],
                }
            return None
        except Exception as e:
            print(f"Error getting lead: {e}")
            return None

    async def _append_row(self, row_data: List[str]):
        raise NotImplementedError("Google Sheets write via MCP")

    async def _update_by_phone(self, phone: str, column: str, value: str):
        raise NotImplementedError("Google Sheets update via MCP")

    async def _find_row_by_phone(self, phone: str):
        raise NotImplementedError("Google Sheets read via MCP")


# ── OAuth helpers ──────────────────────────────────────────────────────────────

async def get_google_oauth_url(tenant_id: str, service: str) -> str:
    """Generate OAuth URL for clinic to authorize Google Calendar/Sheets access."""
    base_url = os.getenv("BACKEND_URL")
    redirect_uri = f"{base_url}/api/integrations/google/callback"
    state = json.dumps({"tenant_id": tenant_id, "service": service})
    scopes = {
        "calendar": "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
        "sheets": "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    }
    scope = scopes.get(service, scopes["calendar"])
    client_id = os.getenv("GOOGLE_CLIENT_ID")
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
        update_data["google_calendar_refresh"] = refresh_token
        if calendar_id:
            update_data["google_calendar_id"] = calendar_id
    elif service == "sheets":
        update_data["google_sheets_token"] = access_token
        update_data["google_sheets_refresh"] = refresh_token
        if spreadsheet_id:
            update_data["google_sheets_id"] = spreadsheet_id

    supabase.table("tenant_settings").update(update_data).eq("tenant_id", tenant_id).execute()


# ── Per-tenant instance getters ────────────────────────────────────────────────

async def get_google_calendar(tenant_id: str) -> Optional[GoogleCalendarIntegration]:
    from shared.tenant_config import get_tenant_by_id

    tenant = await get_tenant_by_id(tenant_id)
    if tenant and tenant.google_calendar_id:
        return GoogleCalendarIntegration(tenant_id=tenant_id, calendar_id=tenant.google_calendar_id)
    return None


async def get_google_sheets(tenant_id: str) -> Optional[GoogleSheetsIntegration]:
    from shared.tenant_config import get_tenant_by_id

    tenant = await get_tenant_by_id(tenant_id)
    if tenant and tenant.google_sheets_id:
        return GoogleSheetsIntegration(tenant_id=tenant_id, spreadsheet_id=tenant.google_sheets_id)
    return None

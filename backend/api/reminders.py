"""
Appointment Reminder Scheduler
Runs every 30 minutes, sends WhatsApp reminders 1 day and 3 hours before appointments.
"""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from shared.tenant_config import get_supabase_client

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="Asia/Kuala_Lumpur")

DEFAULT_1D_TEMPLATE = (
    "Hi {name}, this is a reminder that your {service} appointment is tomorrow, "
    "{date} at {time}. Reply CANCEL if you need to cancel. See you then!"
)
DEFAULT_3H_TEMPLATE = (
    "Hi {name}, your {service} appointment is in about 3 hours at {time} today. "
    "We look forward to seeing you!"
)


def _format_message(template: str, name: str, service: str, scheduled_at: datetime) -> str:
    return (
        template
        .replace("{name}", name or "there")
        .replace("{service}", service or "appointment")
        .replace("{date}", scheduled_at.strftime("%d %b %Y"))
        .replace("{time}", scheduled_at.strftime("%I:%M %p"))
    )


async def _send_wa(to: str, text: str, phone_number_id: str, access_token: str):
    import httpx
    to_digits = to.lstrip("+")
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            url,
            json={"messaging_product": "whatsapp", "to": to_digits, "type": "text", "text": {"body": text}},
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()


async def send_appointment_reminders():
    """Check for upcoming appointments and send WhatsApp reminders."""
    supabase = get_supabase_client()
    now = datetime.now()

    # Load all active tenants that have WA credentials
    tenants_res = supabase.table("tenants").select(
        "id, wa_phone_number_id, wa_access_token"
    ).eq("is_active", True).not_.is_("wa_phone_number_id", "null").execute()

    for tenant_row in (tenants_res.data or []):
        tenant_id = tenant_row["id"]
        phone_number_id = tenant_row.get("wa_phone_number_id")
        access_token = tenant_row.get("wa_access_token")
        if not phone_number_id or not access_token:
            continue

        # Load reminder settings for this tenant
        settings_res = supabase.table("tenant_settings").select(
            "reminder_1d_enabled, reminder_3h_enabled, reminder_1d_template, reminder_3h_template"
        ).eq("tenant_id", tenant_id).maybeSingle().execute()
        settings = settings_res.data or {}

        tasks = []
        if settings.get("reminder_1d_enabled"):
            tasks.append(("1d", timedelta(hours=23), timedelta(hours=25),
                          settings.get("reminder_1d_template") or DEFAULT_1D_TEMPLATE,
                          "reminder_1d_sent"))
        if settings.get("reminder_3h_enabled"):
            tasks.append(("3h", timedelta(hours=2, minutes=30), timedelta(hours=3, minutes=30),
                          settings.get("reminder_3h_template") or DEFAULT_3H_TEMPLATE,
                          "reminder_3h_sent"))

        for reminder_type, window_min, window_max, template, sent_flag in tasks:
            window_start = (now + window_min).isoformat()
            window_end = (now + window_max).isoformat()

            bookings_res = supabase.table("bookings").select(
                "id, service_type, scheduled_at, contact_id, contact:contacts(name, phone)"
            ).eq("tenant_id", tenant_id).in_(
                "status", ["pending", "confirmed"]
            ).gte("scheduled_at", window_start).lte(
                "scheduled_at", window_end
            ).eq(sent_flag, False).execute()

            for booking in (bookings_res.data or []):
                contact = booking.get("contact") or {}
                phone = contact.get("phone", "")
                if not phone:
                    continue

                name = contact.get("name") or "there"
                service = booking.get("service_type", "appointment")
                scheduled_at = datetime.fromisoformat(booking["scheduled_at"])
                message = _format_message(template, name, service, scheduled_at)

                try:
                    await _send_wa(phone, message, phone_number_id, access_token)

                    # Mark sent
                    supabase.table("bookings").update({sent_flag: True}).eq("id", booking["id"]).execute()

                    # Save into the WhatsApp thread if one exists
                    thread_res = supabase.table("whatsapp_threads").select("id").eq(
                        "tenant_id", tenant_id
                    ).eq("contact_number", phone).order("created_at", desc=True).limit(1).execute()

                    if thread_res.data:
                        supabase.table("messages").insert({
                            "thread_id": thread_res.data[0]["id"],
                            "tenant_id": tenant_id,
                            "contact_id": booking.get("contact_id"),
                            "role": "assistant",
                            "body": message,
                            "handled_by": "ai",
                        }).execute()
                        supabase.table("whatsapp_threads").update({
                            "last_message_at": datetime.now().isoformat()
                        }).eq("id", thread_res.data[0]["id"]).execute()

                    logger.info(
                        f"Reminder sent | type={reminder_type} | tenant={tenant_id} | to={phone}"
                    )
                except Exception as e:
                    logger.error(
                        f"Reminder send failed | type={reminder_type} | tenant={tenant_id} | to={phone} | {e}"
                    )

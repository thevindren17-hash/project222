"""
Appointment Reminder Scheduler
Runs every 30 minutes via APScheduler.

Race-condition safety: instead of SELECT → send → UPDATE, we do an atomic
UPDATE WHERE reminder_Xh_sent = false RETURNING * to claim rows first.
Only the process/instance that wins the UPDATE will send the message,
so reminders are never duplicated even on multi-instance Railway deployments.
"""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from shared.tenant_config import get_supabase_client, _db

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

    tenants_res = await _db(lambda: supabase.table("tenants").select(
        "id, wa_phone_number_id, wa_access_token"
    ).eq("is_active", True).not_.is_("wa_phone_number_id", "null").execute())

    for tenant_row in (tenants_res.data or []):
        tenant_id = tenant_row["id"]
        phone_number_id = tenant_row.get("wa_phone_number_id")
        access_token = tenant_row.get("wa_access_token")
        if not phone_number_id or not access_token:
            continue

        settings_res = await _db(lambda: supabase.table("tenant_settings").select(
            "reminder_1d_enabled, reminder_3h_enabled, reminder_1d_template, reminder_3h_template"
        ).eq("tenant_id", tenant_id).maybeSingle().execute())
        settings = settings_res.data or {}

        tasks = []
        if settings.get("reminder_1d_enabled"):
            tasks.append((
                timedelta(hours=23), timedelta(hours=25),
                settings.get("reminder_1d_template") or DEFAULT_1D_TEMPLATE,
                "reminder_1d_sent",
            ))
        if settings.get("reminder_3h_enabled"):
            tasks.append((
                timedelta(hours=2, minutes=30), timedelta(hours=3, minutes=30),
                settings.get("reminder_3h_template") or DEFAULT_3H_TEMPLATE,
                "reminder_3h_sent",
            ))

        for window_min, window_max, template, sent_flag in tasks:
            window_start = (now + window_min).isoformat()
            window_end = (now + window_max).isoformat()

            # Atomic claim: UPDATE WHERE sent_flag = false → only one instance wins per row.
            # The RETURNING gives us exactly the rows we claimed.
            claimed = await _db(lambda: supabase.table("bookings").update({
                sent_flag: True
            }).eq("tenant_id", tenant_id).in_(
                "status", ["pending", "confirmed"]
            ).gte("scheduled_at", window_start).lte(
                "scheduled_at", window_end
            ).eq(sent_flag, False).execute())

            for booking in (claimed.data or []):
                contact_id = booking.get("contact_id")
                if not contact_id:
                    continue

                # Fetch contact details (name + phone) separately after claiming the row
                contact_res = await _db(lambda: supabase.table("contacts").select(
                    "name, phone"
                ).eq("id", contact_id).maybe_single().execute())
                contact = contact_res.data or {}
                phone = contact.get("phone", "")
                if not phone:
                    continue

                name = contact.get("name") or "there"
                service = booking.get("service_type", "appointment")
                scheduled_at = datetime.fromisoformat(booking["scheduled_at"])
                message = _format_message(template, name, service, scheduled_at)

                try:
                    await _send_wa(phone, message, phone_number_id, access_token)

                    # Save reminder into the WhatsApp thread if one exists
                    thread_res = await _db(lambda: supabase.table("whatsapp_threads").select("id").eq(
                        "tenant_id", tenant_id
                    ).eq("contact_number", phone).order("created_at", desc=True).limit(1).execute())

                    if thread_res.data:
                        _thread_id = thread_res.data[0]["id"]
                        await _db(lambda: supabase.table("messages").insert({
                            "thread_id": _thread_id,
                            "tenant_id": tenant_id,
                            "contact_id": contact_id,
                            "role": "assistant",
                            "body": message,
                            "handled_by": "ai",
                        }).execute())
                        await _db(lambda: supabase.table("whatsapp_threads").update({
                            "last_message_at": datetime.now().isoformat()
                        }).eq("id", _thread_id).execute())

                    logger.info(
                        f"Reminder sent | flag={sent_flag} | tenant={tenant_id} | to={phone}"
                    )
                except Exception as e:
                    # Reset the flag so this booking gets retried next run
                    try:
                        _bid = booking["id"]
                        await _db(lambda: supabase.table("bookings").update({
                            sent_flag: False
                        }).eq("id", _bid).execute())
                    except Exception:
                        pass
                    logger.error(
                        f"Reminder send failed | flag={sent_flag} | tenant={tenant_id} | to={phone} | {e}"
                    )

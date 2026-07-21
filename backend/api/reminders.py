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

from shared.tenant_config import get_supabase_client, _db, _db_optional
from shared.scheduler_lock import acquire_lock
from shared.whatsapp_send import send_whatsapp_template

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="Asia/Kuala_Lumpur")

# Both the 1-day and 3-hour reminders send the SAME approved Meta template
# (only one reminder template exists per tenant) — this text mirrors its
# actual approved wording, used only for the readable thread-history log.
DEFAULT_1D_TEMPLATE = (
    "Hi {name},\n\n"
    "This is a reminder that you have a {service} appointment on {date} at {time}.\n\n"
    "Reply CANCEL if you need to reschedule."
)
DEFAULT_3H_TEMPLATE = DEFAULT_1D_TEMPLATE


def _format_message(template: str, name: str, service: str, scheduled_at: datetime) -> str:
    return (
        template
        .replace("{name}", name or "there")
        .replace("{service}", service or "appointment")
        .replace("{date}", scheduled_at.strftime("%d %b %Y"))
        .replace("{time}", scheduled_at.strftime("%I:%M %p"))
    )


async def send_appointment_reminders():
    """Check for upcoming appointments and send WhatsApp reminders."""
    if not await acquire_lock("appointment_reminders", duration_minutes=25):
        logger.info("Reminders: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()
    now = datetime.now()

    tenants_res = await _db(lambda: supabase.table("tenants").select(
        "id, wa_phone_number_id, wa_access_token"
    ).eq("is_active", True).not_.is_("wa_phone_number_id", "null").execute())

    for tenant_row in (tenants_res.data or []):
        tenant_id = tenant_row["id"]
        try:
            phone_number_id = tenant_row.get("wa_phone_number_id")
            access_token = tenant_row.get("wa_access_token")
            if not phone_number_id or not access_token:
                continue

            settings_res = await _db_optional(lambda: supabase.table("tenant_settings").select(
                "reminder_1d_enabled, reminder_3h_enabled, reminder_template_name, whatsapp_template_language"
            ).eq("tenant_id", tenant_id).maybe_single().execute())
            settings = settings_res.data or {}

            # The message body is now a Meta-approved template — its wording
            # is fixed once approved, so there's no per-tenant custom text
            # here anymore, only which approved template name/language to use.
            template_name = settings.get("reminder_template_name") or "appointment_reminder"
            language_code = settings.get("whatsapp_template_language") or "en"

            tasks = []
            if settings.get("reminder_1d_enabled"):
                tasks.append((
                    timedelta(hours=23), timedelta(hours=25),
                    DEFAULT_1D_TEMPLATE,
                    "reminder_1d_sent",
                ))
            if settings.get("reminder_3h_enabled"):
                tasks.append((
                    timedelta(hours=2, minutes=30), timedelta(hours=3, minutes=30),
                    DEFAULT_3H_TEMPLATE,
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

                    try:
                        # Fetch contact details (name + phone) separately after claiming the row
                        contact_res = await _db_optional(lambda: supabase.table("contacts").select(
                            "name, phone"
                        ).eq("id", contact_id).maybe_single().execute())
                        contact = contact_res.data or {}
                        phone = contact.get("phone", "")
                        if not phone:
                            continue

                        name = contact.get("name") or "there"
                        service = booking.get("service_type", "appointment")
                        # A malformed/legacy scheduled_at must only skip THIS booking,
                        # not abort the whole tenant/window — keep it inside the try.
                        scheduled_at = datetime.fromisoformat(booking["scheduled_at"])
                        # message is only used for the readable thread-history log below —
                        # the actual WhatsApp send uses the fixed, Meta-approved template text.
                        message = _format_message(template, name, service, scheduled_at)

                        await send_whatsapp_template(
                            to=phone,
                            template_name=template_name,
                            language_code=language_code,
                            parameters=[
                                name, service,
                                scheduled_at.strftime("%d %b %Y"),
                                scheduled_at.strftime("%I:%M %p"),
                            ],
                            phone_number_id=phone_number_id,
                            access_token=access_token,
                        )

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
                            f"Reminder send failed | flag={sent_flag} | tenant={tenant_id} | booking={booking.get('id')} | {e}"
                        )

        except Exception as e:
            logger.error(f"Appointment reminders: tenant {tenant_id} failed, skipping | {e}", exc_info=True)
            continue

"""
Sending a Meta-approved WhatsApp message template.

Required for any business-initiated message sent outside the 24-hour
customer service window (reminders, feedback requests, recall) — Meta
rejects plain `type: "text"` sends in that case. The template's wording is
fixed once approved; only the {{1}}, {{2}}, ... body variables can differ
per recipient.
"""

from typing import Optional

import httpx


async def send_whatsapp_template(
    to: str,
    template_name: str,
    language_code: str,
    parameters: list,
    phone_number_id: str,
    access_token: str,
    header_image_id: Optional[str] = None,
) -> None:
    """
    header_image_id: a media_id from the regular /{phone_number_id}/media
    upload endpoint (NOT the resumable-upload "header_handle" used only at
    template *creation* time in shared/whatsapp_templates.py) -- required
    when sending a message using a template that was created with an IMAGE
    header, so the send references the actual picture to display each time.
    """
    to_digits = to.lstrip("+")
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    components = [
        {
            "type": "body",
            "parameters": [{"type": "text", "text": str(p)} for p in parameters],
        }
    ]
    if header_image_id:
        components.insert(0, {
            "type": "header",
            "parameters": [{"type": "image", "image": {"id": header_image_id}}],
        })
    payload = {
        "messaging_product": "whatsapp",
        "to": to_digits,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": language_code},
            "components": components,
        },
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()

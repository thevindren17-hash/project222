"""
Sending a Meta-approved WhatsApp message template.

Required for any business-initiated message sent outside the 24-hour
customer service window (reminders, feedback requests, recall) — Meta
rejects plain `type: "text"` sends in that case. The template's wording is
fixed once approved; only the {{1}}, {{2}}, ... body variables can differ
per recipient.
"""

import httpx


async def send_whatsapp_template(
    to: str,
    template_name: str,
    language_code: str,
    parameters: list,
    phone_number_id: str,
    access_token: str,
) -> None:
    to_digits = to.lstrip("+")
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to_digits,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": language_code},
            "components": [
                {
                    "type": "body",
                    "parameters": [{"type": "text", "text": str(p)} for p in parameters],
                }
            ],
        },
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()

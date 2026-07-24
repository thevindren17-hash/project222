"""
Meta WhatsApp Business Platform — Message Templates API.

Lets each clinic submit their own marketing message templates through the
dashboard instead of the founder submitting them by hand for every clinic.
Templates belong to a WhatsApp Business Account (WABA), not a phone number
-- tenants.wa_business_account_id, already collected during WhatsApp connect
(see frontend settings/plugins/whatsapp/page.tsx).

An IMAGE header requires Meta's separate Resumable Upload API to obtain a
"header_handle". This is a DIFFERENT system from the /{phone_number_id}/media
endpoint already used elsewhere in this codebase (_upload_wa_media in
api/whatsapp.py, for outbound voice notes) -- that one returns a media_id
used only for *sending* a message, never a header_handle for *creating* a
template. Conflating the two is the most likely place to get this wrong.

Note: the access_token used here must carry the whatsapp_business_management
permission, not just whatsapp_business_messaging -- if a tenant's existing
token was only ever scoped for sending messages, template calls will fail
with a permissions error and the token needs to be regenerated in Meta
Business Manager with that scope added.
"""

import os
import re
from typing import Any, Dict, List, Optional

import httpx

# Mirrors detectPlaceholderCount() in frontend templates/page.tsx exactly --
# both sides must agree on how many {{n}} variables a body contains.
_PLACEHOLDER_RE = re.compile(r"\{\{(\d+)\}\}")

_GRAPH_VERSION = "v23.0"


async def upload_template_media(
    file_bytes: bytes,
    filename: str,
    mime_type: str,
    access_token: str,
) -> str:
    """
    Two-step Resumable Upload API. Returns the opaque "handle" string Meta
    requires as example.header_handle[0] when creating an IMAGE-header
    template.
    """
    app_id = os.getenv("META_APP_ID")
    if not app_id:
        raise ValueError("META_APP_ID is not configured -- required to upload template header media")

    async with httpx.AsyncClient(timeout=30) as client:
        # Step 1: start an upload session. access_token here is a query
        # param (not an Authorization header) -- this is Meta's documented
        # shape for this specific endpoint, unlike every other Graph call
        # in this codebase.
        start = await client.post(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{app_id}/uploads",
            params={
                "file_name": filename,
                "file_length": len(file_bytes),
                "file_type": mime_type,
                "access_token": access_token,
            },
        )
        start.raise_for_status()
        session_id = start.json()["id"]  # "upload:<SESSION_ID>"

        # Step 2: upload the raw bytes. Note the "OAuth" auth scheme (not
        # "Bearer") -- also part of Meta's documented shape for this
        # endpoint specifically.
        upload = await client.post(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{session_id}",
            content=file_bytes,
            headers={
                "Authorization": f"OAuth {access_token}",
                "file_offset": "0",
            },
        )
        upload.raise_for_status()
        return upload.json()["h"]


async def upload_send_media(
    file_bytes: bytes,
    filename: str,
    mime_type: str,
    phone_number_id: str,
    access_token: str,
) -> str:
    """
    Uploads to the regular /{phone_number_id}/media endpoint (same one
    api/whatsapp.py's _upload_wa_media uses for outbound voice notes,
    generalised here beyond audio) to get a media_id. This is what an
    actual template SEND references for its image header -- distinct from
    upload_template_media's header_handle, which only exists for the one-time
    template *creation* call. Store the media_id once (at template-approval
    time) rather than re-uploading the image on every campaign send.
    """
    import io

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{phone_number_id}/media",
            headers={"Authorization": f"Bearer {access_token}"},
            data={"messaging_product": "whatsapp", "type": mime_type},
            files={"file": (filename, io.BytesIO(file_bytes), mime_type)},
        )
        r.raise_for_status()
        return r.json()["id"]


def _build_template_components(
    body_text: str,
    example_values: List[str],
    footer_text: Optional[str],
    header_handle: Optional[str],
    buttons: Optional[List[Dict[str, str]]] = None,
) -> List[Dict[str, Any]]:
    components: List[Dict[str, Any]] = []
    if header_handle:
        components.append({
            "type": "HEADER",
            "format": "IMAGE",
            "example": {"header_handle": [header_handle]},
        })

    body_component: Dict[str, Any] = {"type": "BODY", "text": body_text}
    if example_values:
        # Meta rejects a submission if any {{n}} placeholder in body_text
        # lacks a matching example value here -- one example SET, itself a
        # list of one value per placeholder in order.
        body_component["example"] = {"body_text": [list(example_values)]}
    components.append(body_component)

    if footer_text:
        components.append({"type": "FOOTER", "text": footer_text})

    if buttons:
        # Static URL buttons only (e.g. "Leave a Review" -> the clinic's
        # Google review link) -- no per-message variable suffix, so nothing
        # extra is needed at send time, the button is baked into the
        # template once it's approved.
        valid_buttons = [
            {"type": "URL", "text": b["text"], "url": b["url"]}
            for b in buttons if b.get("text") and b.get("url")
        ]
        if valid_buttons:
            components.append({"type": "BUTTONS", "buttons": valid_buttons})

    return components


async def create_message_template(
    waba_id: str,
    access_token: str,
    *,
    name: str,
    body_text: str,
    example_values: List[str],
    category: str = "MARKETING",
    language: str = "en",
    footer_text: Optional[str] = None,
    header_handle: Optional[str] = None,
    buttons: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """
    Submits a template for Meta review. Returns {"id": ..., "status": "PENDING"}
    on success. Raises httpx.HTTPStatusError with Meta's own error body
    intact (e.g. "missing example for variable {{2}}") so the real rejection
    reason reaches the clinic instead of a generic 400.
    """
    payload = {
        "name": name,
        "category": category,
        "language": language,
        "components": _build_template_components(body_text, example_values, footer_text, header_handle, buttons),
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{waba_id}/message_templates",
            json=payload,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()
        return r.json()


async def get_template_status(template_id: str, access_token: str) -> Dict[str, Any]:
    """GET the current status + rejection reason (if any) for a submitted template."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{template_id}",
            params={"fields": "status,rejected_reason"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        r.raise_for_status()
        return r.json()


async def list_meta_templates(waba_id: str, access_token: str) -> List[Dict[str, Any]]:
    """
    List every template that already exists on this WABA -- including ones
    approved directly in Meta's own WhatsApp Manager before this dashboard
    feature existed, which this codebase has otherwise never had any way to
    see. Returns Meta's raw template objects (with components); callers
    parse them with _parse_meta_components.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{waba_id}/message_templates",
            params={"fields": "id,name,language,category,status,components", "limit": 100},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        r.raise_for_status()
        return r.json().get("data", [])


async def get_meta_template(meta_template_id: str, access_token: str) -> Dict[str, Any]:
    """
    Re-fetch one template's authoritative definition straight from Meta at
    import time -- rather than trusting whatever a client passed back from
    an earlier list_meta_templates() call, matching how submit_template()
    already treats Meta as the source of truth rather than our own cache.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{meta_template_id}",
            params={"fields": "name,language,category,status,components"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        r.raise_for_status()
        return r.json()


def _parse_meta_components(components: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Reverse of _build_template_components -- turns Meta's component list
    (as returned by list/get, not the shape we send at creation) back into
    the flat fields this dashboard's own whatsapp_templates rows use.

    Meta never stores the "friendly variable name" concept -- that's purely
    invented by this dashboard for templates created here -- so an imported
    template's variables come back as generic placeholders (value_1,
    value_2, ...) sized to however many {{n}} appear in the body. Example
    values also aren't returned by a read call (only required at submission
    time), so example_values comes back empty for an imported row -- fine,
    since an already-approved template is never resubmitted.
    """
    body_text = ""
    footer_text: Optional[str] = None
    header_type: Optional[str] = None
    buttons: List[Dict[str, str]] = []

    for c in components:
        ctype = (c.get("type") or "").upper()
        if ctype == "BODY":
            body_text = c.get("text") or ""
        elif ctype == "FOOTER":
            footer_text = c.get("text")
        elif ctype == "HEADER":
            header_type = (c.get("format") or "").upper() or None
        elif ctype == "BUTTONS":
            for b in c.get("buttons", []):
                if (b.get("type") or "").upper() == "URL" and b.get("text") and b.get("url"):
                    buttons.append({"text": b["text"], "url": b["url"]})

    placeholder_numbers = [int(n) for n in _PLACEHOLDER_RE.findall(body_text)]
    variable_count = max(placeholder_numbers) if placeholder_numbers else 0
    variables = [f"value_{i + 1}" for i in range(variable_count)]

    return {
        "body_text": body_text,
        "footer_text": footer_text,
        "header_type": header_type if header_type == "IMAGE" else None,
        "buttons": buttons or None,
        "variables": variables,
        "example_values": [],
    }

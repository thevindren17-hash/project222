"""
Message Templates Endpoints

Lets a clinic write and submit their own WhatsApp marketing template through
the dashboard -- create a draft, optionally attach an image, submit to Meta
for review, and watch the real approval status -- instead of the founder
submitting every clinic's templates by hand through Meta's own UI.

Flow: POST / (draft) -> POST /{id}/media (optional image) -> POST /{id}/submit
(sends to Meta) -> GET / (list, includes live status) -> poll_pending_template_statuses()
(scheduled job, registered in main.py) keeps status current without a webhook receiver.

Called only from the Next.js proxy routes under frontend/src/app/api/templates/,
which verify the caller owns the tenant before forwarding here with the
internal secret -- see shared/security.py.
"""

import logging
import re
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from shared.security import require_internal_secret
from shared.tenant_config import get_supabase_client, get_tenant_by_id, _db, _db_optional
from shared.scheduler_lock import acquire_lock
from shared.whatsapp_templates import (
    upload_template_media, upload_send_media, create_message_template, get_template_status,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _slugify_template_name(name: str) -> str:
    """Meta template names may only contain lowercase letters, digits, and underscores."""
    slug = re.sub(r"[^a-z0-9_]+", "_", (name or "").lower().strip())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug[:64] or "template"


def _meta_error_detail(exc: Exception) -> str:
    """Surface Meta's own rejection reason (e.g. 'missing example for {{2}}')
    instead of a generic failure, so the clinic can actually act on it."""
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = exc.response.json().get("error", {})
            return body.get("error_user_msg") or body.get("message") or exc.response.text[:300]
        except Exception:
            return exc.response.text[:300]
    return str(exc)


class CreateTemplateRequest(BaseModel):
    tenant_id: str
    name: str
    body_text: str
    variables: List[str] = []
    example_values: List[str] = []
    footer_text: Optional[str] = "Reply STOP to unsubscribe"
    language: str = "en"


class TenantScopedRequest(BaseModel):
    tenant_id: str


@router.post("", dependencies=[Depends(require_internal_secret)])
async def create_draft_template(req: CreateTemplateRequest):
    if not req.body_text.strip():
        raise HTTPException(status_code=400, detail="Template body text is required")

    supabase = get_supabase_client()
    row = {
        "tenant_id": req.tenant_id,
        "name": _slugify_template_name(req.name),
        "language": req.language,
        "body_text": req.body_text,
        "variables": req.variables,
        "example_values": req.example_values,
        "footer_text": (req.footer_text or "").strip() or None,
        "status": "draft",
    }
    res = await _db(lambda: supabase.table("whatsapp_templates").insert(row).execute())
    return res.data[0]


@router.get("", dependencies=[Depends(require_internal_secret)])
async def list_templates(tenant_id: str):
    supabase = get_supabase_client()
    res = await _db(lambda: supabase.table("whatsapp_templates").select("*").eq(
        "tenant_id", tenant_id
    ).order("created_at", desc=True).execute())
    return res.data or []


@router.post("/{template_id}/media", dependencies=[Depends(require_internal_secret)])
async def attach_template_media(template_id: str, tenant_id: str = Form(...), file: UploadFile = File(...)):
    supabase = get_supabase_client()
    tpl_res = await _db_optional(lambda: supabase.table("whatsapp_templates").select("*").eq(
        "id", template_id
    ).eq("tenant_id", tenant_id).maybe_single().execute())
    if not tpl_res.data:
        raise HTTPException(status_code=404, detail="Template not found")

    tenant = await get_tenant_by_id(tenant_id)
    if not tenant or not tenant.wa_access_token or not tenant.wa_phone_number_id:
        raise HTTPException(status_code=400, detail="WhatsApp is not connected for this clinic yet")

    file_bytes = await file.read()
    mime_type = file.content_type or "image/jpeg"
    filename = file.filename or "header.jpg"

    try:
        # Two separate uploads to two different Meta systems -- see the
        # module docstring in shared/whatsapp_templates.py for why both are
        # needed (one for the template *creation* call, one for every
        # actual campaign *send*).
        header_handle = await upload_template_media(file_bytes, filename, mime_type, tenant.wa_access_token)
        header_media_id = await upload_send_media(
            file_bytes, filename, mime_type, tenant.wa_phone_number_id, tenant.wa_access_token
        )
    except Exception as e:
        logger.error(f"Template media upload failed | tenant={tenant_id} | template={template_id} | {e}")
        raise HTTPException(status_code=502, detail=f"Image upload to WhatsApp failed: {_meta_error_detail(e)}")

    res = await _db(lambda: supabase.table("whatsapp_templates").update({
        "header_type": "IMAGE",
        "header_handle": header_handle,
        "header_media_id": header_media_id,
    }).eq("id", template_id).execute())
    return res.data[0]


@router.post("/{template_id}/submit", dependencies=[Depends(require_internal_secret)])
async def submit_template(template_id: str, req: TenantScopedRequest):
    supabase = get_supabase_client()
    tpl_res = await _db_optional(lambda: supabase.table("whatsapp_templates").select("*").eq(
        "id", template_id
    ).eq("tenant_id", req.tenant_id).maybe_single().execute())
    if not tpl_res.data:
        raise HTTPException(status_code=404, detail="Template not found")
    tpl = tpl_res.data
    if tpl["status"] not in ("draft", "rejected"):
        raise HTTPException(status_code=400, detail=f"Template is already {tpl['status']}, can't resubmit")

    tenant = await get_tenant_by_id(req.tenant_id)
    if not tenant or not tenant.wa_access_token or not tenant.wa_business_account_id:
        raise HTTPException(status_code=400, detail="WhatsApp Business Account is not connected for this clinic yet")

    try:
        result = await create_message_template(
            tenant.wa_business_account_id, tenant.wa_access_token,
            name=tpl["name"],
            body_text=tpl["body_text"],
            example_values=tpl.get("example_values") or [],
            language=tpl.get("language") or "en",
            footer_text=tpl.get("footer_text"),
            header_handle=tpl.get("header_handle"),
        )
    except Exception as e:
        err_detail = _meta_error_detail(e)
        await _db(lambda: supabase.table("whatsapp_templates").update({
            "status": "rejected", "rejected_reason": err_detail,
        }).eq("id", template_id).execute())
        raise HTTPException(status_code=400, detail=err_detail)

    res = await _db(lambda: supabase.table("whatsapp_templates").update({
        "meta_template_id": result.get("id"),
        "status": (result.get("status") or "PENDING").lower(),
        "rejected_reason": None,
    }).eq("id", template_id).execute())
    return res.data[0]


@router.delete("/{template_id}", dependencies=[Depends(require_internal_secret)])
async def delete_template(template_id: str, tenant_id: str):
    supabase = get_supabase_client()
    await _db(lambda: supabase.table("whatsapp_templates").delete().eq(
        "id", template_id
    ).eq("tenant_id", tenant_id).execute())
    return {"success": True}


# ── Scheduled job: keep our status column in sync with Meta's review ──────────
# No webhook receiver exists in this codebase, so polling (like every other
# background job here -- reminders, no-show, campaigns) is the simplest fit.

async def poll_pending_template_statuses():
    if not await acquire_lock("poll_template_statuses", duration_minutes=25):
        logger.info("Template status poll: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()

    pending_res = await _db(lambda: supabase.table("whatsapp_templates").select(
        "id, tenant_id, meta_template_id"
    ).eq("status", "pending").not_.is_("meta_template_id", "null").execute())

    for tpl in (pending_res.data or []):
        try:
            tenant = await get_tenant_by_id(tpl["tenant_id"])
            if not tenant or not tenant.wa_access_token:
                continue
            result = await get_template_status(tpl["meta_template_id"], tenant.wa_access_token)
            new_status = (result.get("status") or "").lower()
            if new_status and new_status != "pending":
                _tid = tpl["id"]
                _status = new_status
                _reason = result.get("rejected_reason")
                await _db(lambda: supabase.table("whatsapp_templates").update({
                    "status": _status,
                    "rejected_reason": _reason,
                }).eq("id", _tid).execute())
        except Exception as e:
            logger.error(f"Template status poll failed | template={tpl['id']} | {e}")
            continue

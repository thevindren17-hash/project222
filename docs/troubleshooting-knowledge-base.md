# YourReceiptionist (project222) — Troubleshooting Knowledge Base

Purpose: a record of real problems hit while building this multi-tenant WhatsApp AI
receptionist SaaS, their root causes, and the fixes applied — written so a future
support/debugging agent (or a human) can match a new symptom against a past one and
go straight to the likely cause instead of re-discovering it from scratch.

Each entry is self-contained: symptom, root cause, fix, files touched, and the
general pattern to watch for next time.

---

## System overview (context for every entry below)

- **Frontend**: Next.js (App Router, TypeScript) on Vercel, Supabase client for
  auth/data, TanStack Query, shadcn/ui.
- **Backend**: FastAPI (Python) on Railway. Supabase Postgres (service-role key,
  bypasses RLS). APScheduler background jobs for reminders/campaigns.
- **Multi-tenant**: one row per clinic in `tenants`; `tenant_settings` holds
  per-clinic config. Clinics bring their own LLM provider API key (BYOK —
  Groq/OpenAI/Anthropic/Google/Mistral via OpenAI-compatible endpoints), stored
  encrypted in `tenant_settings.provider_credentials` (JSONB, `enc:v1:` prefix via
  pgcrypto RPC functions). The platform only holds Supabase + LiveKit credentials
  itself.
- **WhatsApp**: Meta Cloud API. Webhook HMAC-SHA256 verified via `WA_APP_SECRET`.
  Inbound messages processed as a FastAPI `BackgroundTask` after the webhook
  returns 200 to Meta.
- **Staff access**: `staff_profiles` links a login to one `tenant_id`; Postgres
  Row Level Security enforces isolation at the database level, not just in
  app code.

---

## 1. AI silently not replying to real WhatsApp messages, despite webhook returning 200

**Symptom**: Meta's webhook delivery log showed 200 OK on every call, but patients
who texted the clinic's WhatsApp number got no reply at all. No errors visible in
the dashboard.

**False leads investigated and ruled out** (documented so they aren't re-chased):
- WABA `subscribed_apps` subscription — this was missing and got fixed, but
  Railway logs proved webhook calls were already arriving *before* that fix, so
  it wasn't the actual cause.
- HMAC signature rejection theory — also ruled out by the same log evidence.

**Root cause**: `supabase-py`/`postgrest-py`'s `.maybe_single()` call, on a
query that matches **zero rows**, can fail in **two different ways** depending
on version/conditions:
1. Raises an exception (`PGRST116` / "Not Acceptable" in the message), or
2. Returns a bare `None` instead of a response object.

The code only handled case 1. When case 2 happened, the next line
(`result.data`) threw `AttributeError: 'NoneType' object has no attribute
'data'` inside a FastAPI `BackgroundTask` — and exceptions in background tasks
never reach the HTTP response cycle, so this failed **completely silently**,
100% of the time a query matched zero rows.

**Fix**: `backend/shared/tenant_config.py` — added `_db_optional()`, a wrapper
that catches both failure modes and normalizes to a safe empty result
(`_EmptyResult` class with `.data = None`). Audited and routed every
`.maybe_single()` call site in the codebase (~20 at the time) through this
wrapper instead of calling it directly.

**Note on the fix process**: the first attempt at this fix assumed only failure
mode 1 existed. Fresh production logs after that deploy showed the *exact same*
crash still happening — proof the first fix was incomplete, not that something
else was wrong. Corrected by handling both modes, verified via a disposable
venv running both failure-mode scenarios before redeploying.

**Pattern to remember**: never call `.maybe_single()` directly anywhere in this
codebase. Always go through `_db_optional()`. When auditing for this bug class,
`grep -rn "maybe_single()" backend/` and confirm every hit is inside a
`_db_optional(lambda: ...)` call, not a bare `try/except` that only checks for
the exception form.

**Files**: `backend/shared/tenant_config.py`, plus every file with a
`.maybe_single()` call (`backend/api/reminders.py`, `backend/api/campaigns.py`,
`backend/shared/google_integrations.py`, etc.)

---

## 2. Test Agent page showing "Error 404"

**Symptom**: the dashboard's Test Agent page failed to reach the backend.

**Root cause**: confusion between `BACKEND_URL` (server-side env var) and
`NEXT_PUBLIC_BACKEND_URL` (client-side, must be `NEXT_PUBLIC_`-prefixed to be
readable in the browser), plus the wrong Railway domain configured, plus
**trailing whitespace in a Vercel environment variable value** — which silently
produced a malformed URL (a literal space breaking the request) with no obvious
error message pointing at the real cause.

**Fix**: corrected the env var values/usage, and defensively added `.trim()` at
every site that reads `BACKEND_URL`/`NEXT_PUBLIC_BACKEND_URL` (~8 files) so a
stray trailing space in a dashboard-configured env var can never break a
request again.

**Pattern to remember**: when a URL-construction bug is suspected and the env
var *looks* correct when eyeballed, check for invisible whitespace before
anything else. `.trim()` defensively on every env var read, not just where the
bug was first found.

---

## 3. Booking flow skipping the patient's name and never asking for notes

**Symptom**: bookings completed successfully but without the patient's full
name recorded, and the AI never asked whether they had any notes/special
requests.

**Root cause**: the booking-flow instructions in the LLM system prompt were
underspecified — no explicit step ordering, no hard rule against skipping or
inventing a name.

**Fix**: rewrote the prompt's step-by-step booking instructions in
`_build_date_context()` (`backend/api/whatsapp.py`), adding explicit hard rules
including "NEVER invent, guess, assume, or reuse a name."

**Pattern to remember**: for LLM-prompt-driven bugs (missing steps, wrong
behavior), the fix is prompt engineering, not code logic — look at
`_build_date_context()` first for anything booking-flow-shaped.

---

## 4. Campaign send errors showing a generic "WhatsApp connection failed" instead of the real reason

**Symptom**: reminder/feedback sends failed with a vague, unhelpful error
message, making it impossible to tell what actually went wrong from the
dashboard.

**Fix**: propagated the real Meta Graph API error message (parsed from the
API's JSON error body) back to the frontend instead of a generic guess.

**Pattern to remember**: always surface the actual upstream API error text to
the user-facing error message where safe to do so (never leak secrets) —
guessing at a generic cause wastes debugging time on both sides.

---

## 5. Reminder/feedback/recall messages failing outside a 24-hour window (the big one)

**Symptom**: campaign messages worked in testing (replying within an active
conversation) but failed once a patient hadn't messaged recently.

**Root cause**: WhatsApp's Cloud API only allows free-form `type: "text"`
messages within a **24-hour customer service window** that opens when a
customer messages the business, and closes 24h after their last message.
Reminders, feedback requests, and recall campaigns are business-initiated and
almost always sent outside that window — Meta rejects free text in that case.
The only way to message a customer outside the window is a pre-approved **Meta
Message Template** (fixed wording with `{{1}}`, `{{2}}`, ... numbered
variables, submitted for Meta review in advance).

**Fix** (multi-part):
- `backend/shared/whatsapp_send.py` — new `send_whatsapp_template()` helper
  that sends `type: "template"` payloads.
- `backend/migrations/007_whatsapp_templates.sql` — added
  `reminder_template_name`, `feedback_template_name`, `recall_template_name`,
  `whatsapp_template_language` columns to `tenant_settings` (per-tenant, since
  every clinic must get their own template approved on their own WABA).
- `backend/api/reminders.py` and `backend/api/campaigns.py` (feedback path)
  switched to `send_whatsapp_template()`. Recall intentionally stayed on the
  old free-text path (`_send_wa()`) until its template gets approved — a
  conscious decision, not an oversight.
- Frontend: the Reminder/Feedback settings pages' editable "write your own
  message" textareas were replaced with a **read-only preview** of the
  approved template wording — a clinic's custom text was never actually what
  got sent once outside the 24h window, so letting them edit it was
  misleading.

**Two follow-up corrections after the above shipped:**
- **Language code**: initially defaulted to `en_US` everywhere. Meta's
  WhatsApp Manager showed the actual approved templates' language as plain
  "English" — which maps to code `en`, not `en_US`. Wrong language code =
  every send fails with "template not found." Fixed the default in the
  migration and all four send call-sites, plus added a one-time `UPDATE`
  normalizing any already-applied `en_US` rows to `en`.
- **Wording/variable count**: initially guessed placeholder preview text.
  Once the user shared screenshots of the actual approved templates from
  Meta's WhatsApp Manager, confirmed the real body text and variable order —
  `{{1}}=name, {{2}}=service, {{3}}=date, {{4}}=time` for reminder,
  `{{1}}=name, {{2}}=service` for feedback — which happened to already match
  what the code sent, but the *displayed* preview/log text was rewritten to
  match the real approved wording exactly (previously it was a plausible
  guess, not the real text).

**Pattern to remember**: for any WhatsApp business-initiated messaging
feature, before writing code, get from the user: (1) the exact approved
template name, (2) the full approved body text with every `{{n}}` visible
(not just a truncated preview), (3) the exact language code shown in
WhatsApp Manager. Never assume `en_US` — check.

**Files**: `backend/shared/whatsapp_send.py`,
`backend/migrations/007_whatsapp_templates.sql`, `backend/api/reminders.py`,
`backend/api/campaigns.py`, `frontend/src/app/(dashboard)/campaigns/reminders/page.tsx`,
`frontend/src/app/(dashboard)/campaigns/feedback/page.tsx`,
`frontend/src/app/api/campaigns/send-csv/route.ts`,
`frontend/src/app/api/test/send-template/route.ts`

---

## 6. Inbound WhatsApp message handler could go completely silent on setup-phase failures

**Symptom**: not yet observed in production, found during a pre-pilot audit —
a latent bug, not a reported incident.

**Root cause**: `handle_whatsapp_message` (`backend/api/whatsapp.py`) had a
try/except around the LLM call itself (added in an earlier fix pass, with a
fallback apology message + human escalation), but everything *before* the LLM
call — contact/thread lookup, the opt-out check, emergency/escalation
guardrails, the feedback-campaign intercept, conversation-history building —
had no such protection. A failure anywhere in that setup phase (a transient DB
error, a bug in a called function) would propagate out of the background task
and the patient would get **total silence**, not even the fallback message,
since that logic only ran once execution reached the already-guarded block.

**Fix**: wrapped the entire setup phase in its own try/except, with the same
fallback pattern — log with full context, attempt to send an apology message
using the raw `from_number` and tenant credentials (available from the very
top of the function, so this works even if contact/thread resolution itself
is what failed), attempt to escalate to a human, then return.

**Pattern to remember**: in any FastAPI `BackgroundTask`, assume nothing
downstream will ever see an exception raised here. If a background task has a
multi-step setup phase before its "main" guarded logic, the setup phase needs
its own guard too — a partial try/except around just the risky-looking part
is not enough coverage.

---

## 7. `google_integrations.py` regressed the exact bug from #1

**Symptom**: found during a pre-pilot audit, not yet a reported incident.

**Root cause**: `_get_token()` and `get_google_calendar()` in
`backend/shared/google_integrations.py` called `.maybe_single()` directly and
only caught the exception-raising failure mode (see #1) — not routed through
`_db_optional()`. Any tenant without Google Calendar connected would hit the
bare-`None` failure mode and crash with the same `AttributeError` as #1.
Additionally, 4 Supabase calls in this file were made directly
(`supabase.table(...).execute()`) inside `async def` functions without going
through the `_db()`/`_db_optional()` thread-pool wrappers — blocking,
synchronous HTTP calls stalling the event loop (and therefore every other
tenant's concurrent request) for the duration of each Google API round-trip.

**Fix**: routed both `.maybe_single()` sites through `_db_optional()`; wrapped
all 4 direct blocking calls through `_db()`.

**Pattern to remember**: a fix for one bug class doesn't automatically apply
to new/less-frequently-touched files. When a bug class like #1 is found,
`grep` the *entire* backend for the same pattern, not just the file where it
was first noticed — this file was missed in the original sweep because it
wasn't part of the active WhatsApp message flow at the time.

---

## 8. Bulk campaign sends: no visibility into per-contact failures, no abuse protection

**Symptom**: found during a pre-pilot audit. A receptionist uploading a CSV of
patients and seeing "12 failed" had no way to know which 12 patients, or why
— making it impossible to fix and resend without re-uploading the whole batch
and guessing. Separately, the bulk-send endpoint (up to hundreds of real
WhatsApp messages per call) had no rate limiting — a bug or compromised
session could hammer it in a loop and risk the clinic's WABA getting flagged
for spam.

**Fix**: server now returns per-contact `{name, phone, status, reason}`
details for every skipped/failed row, rendered as a table in the CSV
uploader UI. Added an in-memory per-tenant rate limiter (max 5 bulk-send
calls per 15 min) and reduced the per-upload contact cap from 500 to 300.

**Pattern to remember**: any bulk-operation endpoint needs (a) a rate limit
independent of normal API abuse protection, since a single legitimate call is
expected to be "high volume" by design, and (b) per-item result detail in the
response, not just aggregate counts — aggregate counts are useless for
actually fixing a partial failure.

**Files**: `frontend/src/app/api/campaigns/send-csv/route.ts`,
`frontend/src/components/campaigns/csv-campaign-uploader.tsx`

---

## 9. Dead legacy DB columns still feeding "preview" text shown to the receptionist

**Symptom**: found during a pre-pilot audit. `reminder_1d_template` and
`feedback_message_template` columns in `tenant_settings` were no longer
written by any UI (since #5's fix replaced the editable textareas with
read-only previews), but were still being *read* by
`frontend/src/app/(dashboard)/appointments/page.tsx` and
`frontend/src/app/api/test/send-template/route.ts` to build the message text
shown to the receptionist as "what will be sent." If a clinic had old data in
those columns from before the template migration, the dashboard would show
wording the patient never actually received (since the real send always uses
the fixed approved template).

**Fix**: removed the dead reads; the displayed/logged text now always comes
from a fixed constant that mirrors the real approved template wording.

**Pattern to remember**: when a data flow changes from "read a custom DB
value" to "use a fixed constant," grep for every other place that old column
was ever read, not just the primary write path — display/logging code paths
are easy to miss since they don't error, they just silently show stale data.

---

## 10. Live database leak: `voice_sessions` readable by anyone, unauthenticated

**Symptom**: found during a direct RLS/policy audit of the live Supabase
project (not from an incident report). A leftover Row Level Security policy
named `"anon read"` on the `voice_sessions` table had `qual: true` — meaning
**any request with the public anon key (which ships embedded in the frontend
JavaScript bundle, effectively public) could read every tenant's row**, no
login required. 62 rows exposed: `tenant_id`, `contact_id`, `livekit_room_id`,
call metadata, across every clinic.

**Root cause**: leftover from earlier LiveKit voice-feature development,
never removed once the rest of the schema's RLS policies were properly
tenant-scoped.

**Fix**: dropped the `"anon read"` policy; added the same owner/staff
tenant-scoped SELECT policies used on every other table.

**Pattern to remember**: a tracked `supabase_schema.sql` file in the repo can
drift from the live database's actual state — this project's tracked schema
file didn't even list several tables (`campaigns`, `staff_profiles`,
`staff_invites`) that the live DB had already correctly secured via an
`rls_auto_enable()` event trigger. **Always verify RLS/policy state directly
against the live database** (`pg_tables.rowsecurity`, `pg_policies`) before
concluding something is broken *or* fine — don't trust the tracked file
either way. This also caught 6 functions with a mutable `search_path`
(schema-hijacking hardening, including the credential encrypt/decrypt
functions) via Supabase's built-in security advisor (`get_advisors`).

**Files**: fix applied live via Supabase SQL, recorded in
`backend/migrations/008_voice_sessions_rls_and_hardening.sql`

---

## General patterns for this codebase (not tied to one incident)

- **`.maybe_single()` must always go through `_db_optional()`** (see #1, #7).
  This is the single most-repeated bug class in this project.
- **FastAPI `BackgroundTask`s swallow exceptions silently** — any code that
  runs as a background task after a webhook/route returns 200 needs its own
  complete try/except coverage, not partial coverage around just the "risky
  looking" part (see #6).
- **Multi-tenant scheduler loops** (`reminders.py`, `campaigns.py`) must wrap
  each tenant's processing in its own try/except — one tenant's bad data must
  never abort the batch for every other tenant.
- **`print()` is invisible to monitoring** — Sentry's default integration
  only auto-captures `logger.*` calls, not `print()` output. Always use the
  module `logger`.
- **Don't trust a tracked schema/config file over the live system** — verify
  database state, environment variables, and deployed config directly rather
  than assuming a repo file reflects reality (see #10, and the earlier env
  var whitespace bug in #2).
- **WhatsApp business-initiated messages need an approved template outside
  the 24h customer-service window** — this applies to any *new* proactive
  messaging feature, not just the three campaigns already built (see #5).
- **Verification gate before every push**: `npx tsc --noEmit` (frontend),
  Python `ast.parse`/`py_compile` sweep on changed files, and for
  higher-risk backend changes, a disposable venv (`python -m venv
  /tmp/venvcheckN`) importing the full FastAPI app with dummy env vars to
  catch import-time errors before deploying.

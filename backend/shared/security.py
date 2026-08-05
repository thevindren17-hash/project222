"""
Shared request-authentication helpers.

require_internal_secret gates endpoints that must only ever be called by our
own Next.js server (which verifies the logged-in user's session and tenant
ownership first) — never directly by a browser or any other caller on the
internet. The Next.js proxy routes send the same secret via the
X-Internal-Secret header on every forwarded request.
"""

import hashlib
import hmac
import os
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException


def require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    secret = os.getenv("INTERNAL_API_SECRET", "")
    if not secret or not hmac.compare_digest(x_internal_secret, secret):
        raise HTTPException(status_code=403, detail="Invalid or missing X-Internal-Secret header")


# ── Tenant-scoped action tokens ─────────────────────────────────────────────
# Some flows (Google OAuth start/callback) redirect the browser through
# third-party pages (Google's consent screen), so they can't carry the
# X-Internal-Secret header the way a normal server-to-server call can — the
# backend endpoint is reachable directly over the internet with nothing but
# a URL. sign_tenant_action lets the Next.js server (which already ran
# verifyTenantAccess against the logged-in user's session) stamp a
# short-lived, tenant-bound proof that a *specific* tenant_id was actually
# authorized, rather than the backend trusting whatever tenant_id shows up
# in a query param or an OAuth `state` value. Mirrored in
# frontend/src/lib/server/verify-tenant-access.ts (signTenantAction) using
# the same INTERNAL_API_SECRET, so both sides derive the same signature.
def sign_tenant_action(tenant_id: str, ttl_seconds: int = 300) -> "tuple[int, str]":
    secret = os.getenv("INTERNAL_API_SECRET", "")
    exp = int(time.time()) + ttl_seconds
    sig = hmac.new(secret.encode(), f"{tenant_id}:{exp}".encode(), hashlib.sha256).hexdigest()
    return exp, sig


def verify_tenant_action(tenant_id: str, exp: "int | str", sig: str) -> bool:
    secret = os.getenv("INTERNAL_API_SECRET", "")
    if not secret or not tenant_id or not sig:
        return False
    try:
        exp_int = int(exp)
    except (TypeError, ValueError):
        return False
    if int(time.time()) > exp_int:
        return False
    expected = hmac.new(secret.encode(), f"{tenant_id}:{exp_int}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


class RateLimiter:
    """In-memory sliding-window limiter, keyed by an arbitrary string (e.g. tenant_id)."""

    def __init__(self, max_calls: int, window_seconds: float):
        self._max_calls = max_calls
        self._window = window_seconds
        self._store: dict = defaultdict(lambda: deque(maxlen=max_calls * 2))

    def hit(self, key: str) -> bool:
        """Record a call and return True if it should be BLOCKED (limit exceeded)."""
        now = time.monotonic()
        q = self._store[key]
        while q and now - q[0] > self._window:
            q.popleft()
        if len(q) >= self._max_calls:
            return True
        q.append(now)
        return False

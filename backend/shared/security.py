"""
Shared request-authentication helpers.

require_internal_secret gates endpoints that must only ever be called by our
own Next.js server (which verifies the logged-in user's session and tenant
ownership first) — never directly by a browser or any other caller on the
internet. The Next.js proxy routes send the same secret via the
X-Internal-Secret header on every forwarded request.
"""

import hmac
import os
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException


def require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    secret = os.getenv("INTERNAL_API_SECRET", "")
    if not secret or not hmac.compare_digest(x_internal_secret, secret):
        raise HTTPException(status_code=403, detail="Invalid or missing X-Internal-Secret header")


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

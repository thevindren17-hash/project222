"""
Conversation State Management
Tracks per-call state: language, turn count, escalation status, booking count.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Optional


@dataclass
class ConversationState:
    tenant_id: str
    contact_id: Optional[str] = None
    language: str = "en"
    turn_count: int = 0
    unclear_count: int = 0
    booking_count: int = 0
    escalated: bool = False
    call_start: datetime = field(default_factory=datetime.now)
    history: List[Dict[str, str]] = field(default_factory=list)

    def add_message(self, role: str, content: str):
        self.history.append({"role": role, "content": content})
        if role == "user":
            self.turn_count += 1
            if not content.strip():
                self.unclear_count += 1
            else:
                self.unclear_count = 0

    def duration_seconds(self) -> int:
        return int((datetime.now() - self.call_start).total_seconds())

    def quality_flags(self) -> List[str]:
        flags = []
        if self.turn_count > 8:
            flags.append("long_conversation")
        if self.unclear_count > 1:
            flags.append("audio_issues")
        if self.escalated:
            flags.append("escalated")
        if self.booking_count > 2:
            flags.append("multiple_bookings")
        return flags

"""
Utility Functions
"""

import re
import logging
from typing import Optional
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("ai-receptionist")


def detect_language(text: str) -> str:
    """
    Heuristic language detection.  Returns 'en', 'ms', or 'zh'.
    """
    if not text:
        return "en"

    text_lower = text.lower()

    chinese_score = len(re.findall(r"[一-鿿]", text))
    if chinese_score > 2:
        return "zh"

    malay_words = [
        "nak", "saya", "boleh", "dengan", "untuk", "ada", "tak", "atau",
        "sini", "mana", "esok", "buat", "nama", "hari", "ini", "telefon",
        "nombor", "ya", "tidak", "awak", "kita", "kami", "mereka", "dia",
        "appointment", "temujanji", "tarikh", "masa", "pagi", "petang",
        "malam", "minggu", "bulan", "tolong", "terima", "kasih", "selamat",
        "pergi", "datang", "baik", "okay", "lah", "pun", "juga", "dah",
        "sudah", "akan", "nanti", "lepas", "sebelum", "berapa", "bila",
    ]
    malay_score = sum(1 for w in malay_words if w in text_lower.split())
    if malay_score >= 1:
        return "ms"

    return "en"


# By the time a tool call reaches check_slots/book_appointment, the LLM has
# already converted whatever the patient said into an absolute YYYY-MM-DD —
# so the resulting argument always LOOKS like a real date whether or not the
# patient actually said one. This checks the raw conversation text itself
# (before that conversion) for something date-shaped, so a model that skips
# asking and just guesses "tomorrow" can be caught and stopped, rather than
# trusting the tool argument at face value.
_DATE_MENTION_RE = re.compile(
    r"\b("
    r"mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|"
    r"tomorrow|today|tonight|esok|lusa|"
    r"next|depan|akan\s?datang|this\s?week|minggu|"
    r"jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|"
    r"january|february|march|april|june|july|august|september|october|november|december"
    r")\b"
    r"|\b\d{1,2}(st|nd|rd|th)\b"
    r"|\b\d{1,2}[/-]\d{1,2}\b"
    r"|\b\d{4}-\d{2}-\d{2}\b"
    r"|hari\s?ini",
    re.IGNORECASE,
)


def mentions_a_date(text: str) -> bool:
    return bool(_DATE_MENTION_RE.search(text or ""))


def conversation_mentions_a_date(messages: list) -> bool:
    """messages: list of {"role":..., "content":...} — True if any user turn
    so far said something date-shaped."""
    return any(
        m.get("role") == "user" and mentions_a_date(m.get("content", ""))
        for m in messages
    )


def parse_datetime(date_str: str, time_str: str) -> Optional[datetime]:
    """Parse date + time strings into a datetime object."""
    try:
        dt_str = f"{date_str} {time_str}"
        for fmt in ("%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M"):
            try:
                return datetime.strptime(dt_str, fmt)
            except ValueError:
                continue
        return None
    except Exception as e:
        logger.error(f"Error parsing datetime: {e}")
        return None


def format_phone_number(phone: str) -> str:
    """Normalise phone to E.164.  Defaults to Malaysian (+60) format."""
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("60"):
        return f"+{digits}"
    if digits.startswith("0"):
        return f"+6{digits}"
    if len(digits) in (9, 10):
        return f"+60{digits}"
    return f"+{digits}"


def is_business_hours(tenant_config, check_time: Optional[datetime] = None) -> bool:
    """Return True if check_time falls within the tenant's business hours."""
    if check_time is None:
        check_time = datetime.now()

    day_name = check_time.strftime("%a").lower()
    day_config = tenant_config.business_hours.get(day_name)

    if not day_config or day_config.get("closed"):
        return False

    time_str = check_time.strftime("%H:%M")
    return day_config["open"] <= time_str <= day_config["close"]


EMERGENCY_KEYWORDS = [
    # English
    "emergency", "urgent", "pain", "bleeding", "swelling", "broken tooth",
    "can't breathe", "accident", "fell", "injury", "hurts badly", "severe",
    # Bahasa Melayu
    "kecemasan", "segera", "sakit", "pendarahan", "bengkak", "patah", "tolong", "teruk",
    # Chinese
    "紧急", "疼", "痛", "流血", "肿", "断", "帮助",
]

ESCALATION_PHRASES = [
    # English
    "speak to someone", "talk to a person", "human", "staff", "real person",
    "not working", "frustrated", "manager", "doctor",
    # Bahasa Melayu
    "cakap dengan orang", "jumpa staff", "tak faham", "tak betul",
    # Chinese
    "转人工", "找人", "真人", "客服",
]


def check_emergency(text: str) -> bool:
    """Return True if text contains emergency keywords."""
    text_lower = text.lower()
    return any(kw in text_lower for kw in EMERGENCY_KEYWORDS)


def check_escalation_request(text: str) -> bool:
    """Return True if user is requesting a human."""
    text_lower = text.lower()
    return any(phrase in text_lower for phrase in ESCALATION_PHRASES)

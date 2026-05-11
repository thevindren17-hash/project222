# AI Agent Conversation Guardrails

**Critical for Production - Add to Backend Build Instructions**

---

## 1. Double Booking Prevention

Already added to `book_appointment()` in tools.py:

```python
# Checks for existing bookings in 30-minute window
# Returns error: "double_booking" if conflict found
# Agent responds: "That time slot is already taken. Would you like me to check other available times?"
```

---

## 2. System Prompt Guardrails

Replace the default system prompt in `/backend/shared/tenant_config.py` with this production version:

```python
def _default_system_prompt(clinic_name: str) -> str:
    """Generate default system prompt with comprehensive guardrails"""
    return f"""You are Maya, an AI receptionist for {clinic_name}.

Your job:
- Book, reschedule, and cancel appointments
- Answer questions about clinic hours, location, services, and pricing
- Check doctor/dentist availability
- Take messages for staff
- Transfer to a human when requested or when you cannot help

You must never:
- Give medical or dental advice
- Diagnose any condition
- Confirm exact prices (say 'please contact us for pricing')
- Make up information not in your tools or FAQ
- Book appointments in the past
- Book outside of business hours without confirming
- Promise specific doctors unless confirmed via tools

CONVERSATION GUARDRAILS:

1. GREETING: Keep it brief (under 15 words). Don't list all services upfront.
   ✓ Good: "Hello, you've reached {clinic_name}. How can I help you today?"
   ✗ Bad: "Hello! Welcome to {clinic_name}. We offer scaling, checkup, whitening, extraction..."

2. RESPONSES: Be concise. One action per response. Maximum 2 sentences.
   ✓ Good: "I can book that for you. Which date works best?"
   ✗ Bad: "Absolutely! I'd be delighted to help you schedule an appointment. We have various time slots available. Would you prefer morning or afternoon? We also offer multiple services..."

3. CONFIRMATIONS: Always repeat back critical details before finalizing.
   ✓ "Just to confirm: scaling appointment on May 15 at 2 PM. Is that correct?"
   
4. AMBIGUITY: Ask ONE clarifying question at a time.
   ✓ Good: "Which service do you need - checkup or cleaning?"
   ✗ Bad: "What service do you need? And what date? And what time? And which doctor?"

5. SILENCE/UNCLEAR: After 2 unclear responses, offer human transfer.
   "I'm having trouble understanding. Would you like me to connect you with someone?"

6. ESCALATION TRIGGERS (immediate transfer):
   - Patient says: "speak to someone", "human", "staff", "manager", "doctor"
   - Emergency keywords: "pain", "emergency", "urgent", "bleeding", "swelling", "broken tooth"
   - Patient is frustrated (raised tone, repeating themselves 3+ times)
   - You cannot help after 2 attempts
   - Complaint or refund request

7. SAFETY BOUNDARIES:
   - Don't book more than 3 appointments in one conversation (potentially suspicious)
   - Don't accept bookings more than 3 months out (say "For bookings that far out, please call us directly")
   - Don't cancel appointments scheduled within 2 hours (say "For cancellations this close to your appointment, please call us")
   - Don't book before 7 AM or after 10 PM (say "That's outside our booking hours")

8. PROHIBITED TOPICS:
   - Medical advice: "I can't provide medical advice. Please consult our dentist."
   - Specific pricing: "For accurate pricing, please contact us at [number]."
   - Insurance claims: "Our staff can help you with that. Let me transfer you."
   - Complaints: "I understand your frustration. Let me connect you with someone who can help resolve this."
   - Legal questions: "I'm not qualified to answer that. Let me transfer you to someone who can help."

9. DATA PRIVACY:
   - Never ask for IC/NRIC numbers, credit card details, passwords, or medical history
   - Never read back full phone numbers (confirm last 4 digits only: "Is your number ending in 5678?")
   - Never share information about other patients
   - Never confirm appointments for someone else without verification

10. NATURAL CONVERSATION:
   - Use contractions: "I'll" not "I will", "you're" not "you are"
   - Acknowledge naturally: "Got it", "Perfect", "I understand", "Okay"
   - No robotic phrases: 
     ✗ "How may I assist you today"
     ✓ "How can I help?"
   - No over-apologizing:
     ✗ "I sincerely apologize for any inconvenience this may have caused"
     ✓ "Sorry about that"
   - Match patient's energy: If they're casual, be casual. If formal, be professional.

11. LANGUAGE SWITCHING:
   - Respond in the language the patient uses
   - If patient switches mid-conversation, switch immediately
   - Don't ask "Would you like to continue in English?" - just switch
   - Supported: English, Bahasa Melayu (BM), Mandarin Chinese (ZH)

12. TIME AWARENESS:
   - If patient calls outside business hours, say: "We're currently closed. Our hours are [hours]. Would you like to book an appointment for when we're open?"
   - Don't offer same-day appointments after 4 PM (too late)
   - For urgent requests outside hours: "This sounds urgent. Our emergency line is [number]."

13. ERROR RECOVERY:
   - If a tool fails, never say "system error" or expose technical details
   - Instead: "I'm having trouble with that. Let me transfer you to someone who can help."
   - If LLM is slow, add filler: "Let me check that for you..." (prevents dead air)

14. CONVERSATION LENGTH:
   - Target: Complete booking in under 2 minutes
   - If conversation exceeds 10 turns without progress, offer transfer
   - If patient keeps asking unrelated questions, gently redirect: "I can help with that. First, did you still want to book an appointment?"

Language: Respond in the same language the patient uses. Supported: English, Bahasa Melayu, Mandarin Chinese.

IMMEDIATE ESCALATION PHRASES (in any language):
- English: "speak to someone", "talk to a person", "human", "staff", "real person", "not working", "frustrated"
- Bahasa Melayu: "cakap dengan orang", "jumpa staff", "tak faham", "tak betul"
- Chinese: "转人工", "找人", "真人", "客服"
"""
```

---

## 3. Conversation Turn Limit

Add to voice agent `main.py`:

```python
class VoiceAgent:
    def __init__(self, tenant_config: TenantConfig, ctx: JobContext):
        # ... existing code ...
        self.turn_count = 0
        self.max_turns = 10  # Escalate after 10 back-and-forth exchanges
        self.unclear_response_count = 0
    
    async def handle_call(self):
        # ... existing greeting code ...
        
        # Conversation loop
        while self.turn_count < self.max_turns:
            try:
                self.turn_count += 1
                
                user_input = await self._listen()
                
                if not user_input:
                    self.unclear_response_count += 1
                    if self.unclear_response_count >= 2:
                        await self._speak("I'm having trouble hearing you clearly. Let me transfer you to someone who can help.")
                        await self._escalate("unclear_audio")
                        break
                    continue
                
                # Reset unclear counter if we got input
                self.unclear_response_count = 0
                
                # ... rest of conversation logic ...
                
            except Exception as e:
                logger.error(f"Error in conversation loop: {e}")
                await self._speak("I apologize, I'm having trouble. Let me transfer you to someone who can help.")
                await self._escalate("technical_error")
                break
        
        # Max turns reached
        if self.turn_count >= self.max_turns:
            await self._speak("I want to make sure you get the best help. Let me transfer you to someone on our team.")
            await self._escalate("max_turns_reached")
```

---

## 4. Emergency Detection

Add to voice agent before LLM call:

```python
async def _check_for_emergency(self, user_input: str) -> bool:
    """Check if user message contains emergency keywords"""
    emergency_keywords = [
        # English
        'emergency', 'urgent', 'pain', 'bleeding', 'swelling', 'broken tooth',
        'can\'t breathe', 'accident', 'fell', 'injury', 'help', 'hurts badly',
        # Bahasa Melayu  
        'kecemasan', 'segera', 'sakit', 'pendarahan', 'bengkak', 'patah',
        'tolong', 'teruk',
        # Chinese
        '紧急', '疼', '痛', '流血', '肿', '断', '帮助'
    ]
    
    user_input_lower = user_input.lower()
    
    for keyword in emergency_keywords:
        if keyword in user_input_lower:
            return True
    
    return False

# In handle_call, after getting user_input:
if await self._check_for_emergency(user_input):
    await self._speak("This sounds like it needs immediate attention. Let me connect you with our staff right away.")
    await self._escalate("emergency")
    break
```

---

## 5. Rate Limiting (Prevent Abuse)

Add to tools.py:

```python
async def check_booking_rate_limit(tenant_id: str, contact_id: str) -> bool:
    """
    Prevent booking spam.
    Allow max 3 bookings per contact per day.
    """
    supabase = get_supabase_client()
    
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    
    bookings_today = supabase.table("bookings").select("id").eq(
        "tenant_id", tenant_id
    ).eq("contact_id", contact_id).gte(
        "created_at", today_start.isoformat()
    ).execute()
    
    if len(bookings_today.data) >= 3:
        return False  # Rate limit exceeded
    
    return True

# In book_appointment, before inserting:
if not await check_booking_rate_limit(tenant_id, contact_id):
    return {
        "success": False,
        "error": "rate_limit",
        "message": "You've reached the maximum bookings for today. Please call us if you need additional appointments."
    }
```

---

## 6. Business Hours Validation

Add to tools.py:

```python
def validate_booking_time(scheduled_at: datetime, business_hours: Dict) -> Dict[str, Any]:
    """
    Validate booking is during business hours.
    """
    # Check if in the past
    if scheduled_at < datetime.now():
        return {
            "valid": False,
            "error": "Cannot book appointments in the past"
        }
    
    # Check if too far in future (> 3 months)
    if scheduled_at > datetime.now() + timedelta(days=90):
        return {
            "valid": False,
            "error": "For bookings more than 3 months out, please contact us directly"
        }
    
    # Check day of week
    day_name = scheduled_at.strftime("%a").lower()
    day_hours = business_hours.get(day_name)
    
    if not day_hours or day_hours.get('closed'):
        return {
            "valid": False,
            "error": f"We're closed on {scheduled_at.strftime('%A')}s"
        }
    
    # Check time is within hours
    time_str = scheduled_at.strftime("%H:%M")
    if not (day_hours['open'] <= time_str <= day_hours['close']):
        return {
            "valid": False,
            "error": f"That's outside our hours. We're open {day_hours['open']} to {day_hours['close']}"
        }
    
    return {"valid": True}

# In book_appointment, add validation:
validation = validate_booking_time(scheduled_at, tenant_config.business_hours)
if not validation["valid"]:
    return {
        "success": False,
        "error": "invalid_time",
        "message": validation["error"]
    }
```

---

## 7. Logging for Quality Monitoring

Add to call_logs when saving:

```python
async def save_call_log(self):
    """Save call with quality flags for review"""
    
    # Detect quality issues
    quality_flags = []
    
    if self.turn_count > 8:
        quality_flags.append("long_conversation")
    
    if self.unclear_response_count > 1:
        quality_flags.append("audio_issues")
    
    # Check if multiple escalation attempts
    escalation_count = str(self.conversation_history).lower().count("transfer")
    if escalation_count > 1:
        quality_flags.append("multiple_escalations")
    
    call_data = {
        # ... existing fields ...
        "quality_flags": quality_flags,
        "turn_count": self.turn_count
    }
```

---

## Summary Checklist

- [x] Double booking prevention (30-minute window check)
- [x] Comprehensive system prompt guardrails (10 rules)
- [x] Conversation turn limit (10 turns max)
- [x] Emergency keyword detection
- [x] Rate limiting (3 bookings per contact per day)
- [x] Business hours validation
- [x] Time boundary checks (no past, no >3 months out)
- [x] Unclear response handling (escalate after 2 unclear)
- [x] Data privacy rules (no sensitive data)
- [x] Natural conversation patterns
- [x] Quality monitoring flags

**These guardrails make your AI agent production-safe and professional.**

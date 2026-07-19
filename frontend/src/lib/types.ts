export interface Tenant {
  id: string
  owner_id: string
  name: string
  default_language: string
  escalation_number?: string
  wa_phone_number?: string
  wa_phone_number_id?: string
  wa_business_account_id?: string
  wa_access_token?: string
  wa_verify_token?: string
  is_active: boolean
  created_at: string
}

export interface TenantSettings {
  id: string
  tenant_id: string
  system_prompt?: string
  agent_name?: string
  llm_config: { provider: string; model: string }
  business_hours: BusinessHours
  faq: Array<{ q: string; a: string }>
  tool_config: Record<string, boolean>
  google_calendar_id?: string
  google_sheets_id?: string
  provider_credentials: Record<string, Record<string, string>>
  escalation_keywords: string[]
  max_turns_before_handoff: number
  created_at: string
}

export interface BusinessHours {
  mon?: { open: string; close: string; closed?: boolean }
  tue?: { open: string; close: string; closed?: boolean }
  wed?: { open: string; close: string; closed?: boolean }
  thu?: { open: string; close: string; closed?: boolean }
  fri?: { open: string; close: string; closed?: boolean }
  sat?: { open: string; close: string; closed?: boolean }
  sun?: { open: string; close: string; closed?: boolean }
}

export interface Booking {
  id: string
  tenant_id: string
  contact_id: string
  service_type: string
  scheduled_at: string
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  source: string
  notes?: string
  calendar_event_id?: string
  created_at: string
  contact?: Contact
}

export interface Contact {
  id: string
  tenant_id: string
  name?: string
  phone: string
  language_preference?: string
  last_contact_at?: string
  created_at: string
}

export interface WhatsAppThread {
  id: string
  tenant_id: string
  contact_id: string
  contact_number: string
  contact_name?: string
  wa_contact_name?: string
  status: 'ai' | 'human_takeover' | 'resolved'
  last_message_at: string
  created_at: string
  tags: string[]
  contact?: Contact
  messages?: WhatsAppMessage[]
}

export interface WhatsAppMessage {
  id: string
  thread_id: string
  tenant_id: string
  role: 'user' | 'assistant'
  handled_by: string
  body: string
  created_at: string
}

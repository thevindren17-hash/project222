# Frontend Build Instructions — AI Receptionist Dashboard

**Production-ready Next.js 14 dashboard for multi-channel AI receptionist SaaS**

Complete self-service platform where clinics control everything:
- ✅ Connect WhatsApp via Meta Cloud API (paste credentials)
- ✅ Connect phone numbers via SIP/VoIP (LiveKit)
- ✅ Configure LLM, STT, TTS providers (Groq, OpenAI, Anthropic, Deepgram, Cartesia, ElevenLabs)
- ✅ Customize AI agent prompt and personality
- ✅ Sync Google Calendar for appointments (two-way sync)
- ✅ Track leads in Google Sheets
- ✅ Monitor live calls, WhatsApp messages, and analytics
- ✅ Manage business hours, FAQ, and team

---

## Architecture Philosophy: Plugins Model

Every integration is a **plugin** the clinic owner installs and configures — like apps on a phone. No developer needed. Everything is self-serve.

```
Dashboard
  ├── 📞 Phone Plugin (SIP/VoIP — connect their number)
  ├── 💬 WhatsApp Plugin (Meta Cloud API — connect their WA)
  ├── 📅 Calendar Plugin (Google Calendar — sync bookings)
  ├── 🤖 AI Plugin (LLM + STT + TTS — pick their stack)
  ├── 🧠 Agent Plugin (System prompt + personality)
  └── 🔔 Notifications (Email / Slack alerts)
```

Clinic owner logs in → sees which plugins are **connected** (green) or **disconnected** (grey) → clicks to configure.

---

## Tech Stack

### Core
- **Next.js 14** (App Router)
- **TypeScript**
- **Tailwind CSS** + **shadcn/ui** (Radix UI components)
- **Supabase** (Auth + Database + Realtime)

### UI Libraries
- **@fullcalendar/react** (calendar views)
- **Recharts** (analytics charts)
- **React Hook Form** + **Zod** (forms & validation)
- **Lucide React** (icons)
- **Sonner** (toast notifications)
- **React Query** (@tanstack/react-query) (server state)
- **Zustand** (client state)

### Additional
- **date-fns** (date handling)
- **next-themes** (dark mode support - optional)

---

## Project Structure

```
/frontend
  /src
    /app
      /(auth)
        /login
          page.tsx
        /register
          page.tsx
        /forgot-password
          page.tsx
        layout.tsx              ← Auth layout (centered card)
      
      /(dashboard)
        layout.tsx              ← Dashboard shell (sidebar + navbar)
        
        /overview
          page.tsx              ← Homepage: metrics, live status, recent activity
        
        /calendar
          page.tsx              ← ⭐ Calendar view (Month/Week/Day) with FullCalendar
        
        /appointments
          page.tsx              ← All bookings table with filters
        
        /call-logs
          page.tsx              ← Voice call history with transcripts
        
        /whatsapp
          page.tsx              ← WhatsApp inbox with live chat
        
        /analytics
          page.tsx              ← Charts and trends
        
        /settings
          /plugins
            /whatsapp
              page.tsx          ← WhatsApp plugin config
            /phone
              page.tsx          ← SIP/VoIP plugin config
            /calendar
              page.tsx          ← Google Calendar OAuth
            /ai-providers
              page.tsx          ← LLM + STT + TTS pickers
            /agent
              page.tsx          ← Agent prompt editor (guided form)
          /clinic-info
            page.tsx            ← Business hours, FAQ, clinic details
          /staff
            page.tsx            ← Team management
          page.tsx              ← Settings hub (plugin cards overview)
    
    /components
      /ui                       ← shadcn components (button, input, card, etc.)
      
      /dashboard
        sidebar.tsx             ← Left navigation
        navbar.tsx              ← Top bar (search, notifications, user menu)
        stat-card.tsx           ← Metric card component
        chart-card.tsx          ← Chart wrapper component
        live-indicator.tsx      ← Green pulse for active calls
        plugin-status-bar.tsx   ← Shows connected vs disconnected plugins
      
      /calendar
        booking-calendar.tsx    ← FullCalendar wrapper
        booking-card.tsx        ← Booking event component
        add-booking-modal.tsx   ← Manual booking form
      
      /plugins
        plugin-card.tsx         ← Reusable plugin card with status
        test-button.tsx         ← Test connection button
        copy-input.tsx          ← Input with copy button
        status-badge.tsx        ← Connected / Disconnected / Error badge
        
        whatsapp-plugin.tsx     ← WhatsApp config form
        phone-plugin.tsx        ← SIP config display
        calendar-plugin.tsx     ← Google OAuth flow
        ai-providers-plugin.tsx ← Provider picker tables
        agent-plugin.tsx        ← Guided prompt form
      
      /appointments
        appointments-table.tsx  ← DataTable with filters
        appointment-detail.tsx  ← Detail modal
      
      /call-logs
        call-log-list.tsx       ← Call history list
        transcript-viewer.tsx   ← Timestamped transcript
      
      /whatsapp
        thread-list.tsx         ← Left panel: threads
        conversation-view.tsx   ← Right panel: messages
        message-bubble.tsx      ← Chat bubble component
        takeover-controls.tsx   ← Take over / Hand back buttons
      
      /analytics
        date-range-picker.tsx   ← Date filter
        chart-line.tsx          ← Line chart wrapper
        chart-bar.tsx           ← Bar chart wrapper
        chart-donut.tsx         ← Donut chart wrapper
        heatmap.tsx             ← Peak hours heatmap
    
    /lib
      supabase.ts             ← Supabase client
      api.ts                  ← API route wrappers
      types.ts                ← TypeScript types
      utils.ts                ← Utility functions
      providers.ts            ← Provider options (LLM, STT, TTS lists)
    
    /hooks
      use-tenant.ts           ← Current tenant data
      use-analytics.ts        ← Analytics queries
      use-appointments.ts     ← Appointments queries
      use-call-logs.ts        ← Call logs queries
      use-whatsapp.ts         ← WhatsApp threads queries
      use-realtime.ts         ← Supabase realtime subscriptions
    
    /styles
      globals.css             ← Global styles + Tailwind + CSS vars
  
  /public
    /images
      logo.svg
      logo-dark.svg
  
  next.config.js
  tailwind.config.ts
  tsconfig.json
  package.json
  .env.local.example
```

---

## Part 1: Design System & Theme

### Color Palette

Based on TailPanel reference but optimized for professional SaaS aesthetic:

```css
/* /src/styles/globals.css */

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* Brand Colors */
    --primary: 214 100% 50%;          /* Blue #0080FF */
    --primary-dark: 214 100% 42%;     /* Hover state */
    --primary-light: 214 100% 96%;    /* Light backgrounds */
    
    /* Neutral Palette */
    --background: 0 0% 100%;          /* White */
    --foreground: 222 47% 11%;        /* Near black text #1A202C */
    --muted: 210 40% 96%;             /* Light gray #F7FAFC */
    --muted-foreground: 215 16% 47%;  /* Gray text #718096 */
    --border: 214 32% 91%;            /* Borders #E2E8F0 */
    
    /* Semantic Colors */
    --success: 142 71% 45%;           /* Green #22C55E */
    --success-light: 142 71% 96%;     
    --warning: 38 92% 50%;            /* Orange #F59E0B */
    --warning-light: 38 92% 96%;
    --error: 0 72% 51%;               /* Red #EF4444 */
    --error-light: 0 72% 97%;
    --info: 199 89% 48%;              /* Cyan #06B6D4 */
    --info-light: 199 89% 96%;
    
    /* Chart Colors */
    --chart-1: 214 100% 50%;          /* Blue */
    --chart-2: 258 90% 66%;           /* Purple */
    --chart-3: 142 71% 45%;           /* Green */
    --chart-4: 38 92% 50%;            /* Orange */
    --chart-5: 0 72% 51%;             /* Red */
    
    /* Card */
    --card: 0 0% 100%;
    --card-hover: 210 40% 98%;
    
    /* Shadows */
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
    
    /* Radius */
    --radius: 0.5rem;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  
  body {
    @apply bg-background text-foreground;
    font-feature-settings: "rlig" 1, "calt" 1;
  }
  
  /* Smooth scrolling */
  html {
    scroll-behavior: smooth;
  }
  
  /* Custom scrollbar */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  
  ::-webkit-scrollbar-track {
    @apply bg-muted;
  }
  
  ::-webkit-scrollbar-thumb {
    @apply bg-muted-foreground/30 rounded-full;
  }
  
  ::-webkit-scrollbar-thumb:hover {
    @apply bg-muted-foreground/50;
  }
}

@layer components {
  /* Stat card glow effect */
  .stat-card-glow {
    position: relative;
    overflow: hidden;
  }
  
  .stat-card-glow::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
    transition: left 0.5s;
  }
  
  .stat-card-glow:hover::before {
    left: 100%;
  }
}
```

### Typography

```typescript
// /src/app/layout.tsx
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ 
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter'
})

export const metadata = {
  title: 'AI Receptionist Dashboard',
  description: 'Multi-channel AI receptionist for clinics',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
```

---

## Part 2: Setup & Installation

### Step 1: Create Next.js Project

```bash
npx create-next-app@latest frontend --typescript --tailwind --app
cd frontend
```

### Step 2: Install Dependencies

```bash
# Core dependencies
npm install @supabase/supabase-js @supabase/auth-helpers-nextjs
npm install @tanstack/react-query
npm install zustand
npm install react-hook-form zod @hookform/resolvers
npm install date-fns
npm install lucide-react
npm install sonner
npm install recharts

# FullCalendar for calendar view
npm install @fullcalendar/react @fullcalendar/daygrid @fullcalendar/timegrid @fullcalendar/interaction

# shadcn/ui CLI (run this to add components)
npx shadcn-ui@latest init
```

### Step 3: shadcn/ui Components

```bash
# Install all needed shadcn components
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
npx shadcn-ui@latest add label
npx shadcn-ui@latest add card
npx shadcn-ui@latest add table
npx shadcn-ui@latest add select
npx shadcn-ui@latest add dialog
npx shadcn-ui@latest add dropdown-menu
npx shadcn-ui@latest add tabs
npx shadcn-ui@latest add badge
npx shadcn-ui@latest add avatar
npx shadcn-ui@latest add separator
npx shadcn-ui@latest add switch
npx shadcn-ui@latest add toast
npx shadcn-ui@latest add popover
npx shadcn-ui@latest add calendar
npx shadcn-ui@latest add checkbox
npx shadcn-ui@latest add radio-group
npx shadcn-ui@latest add textarea
npx shadcn-ui@latest add alert
npx shadcn-ui@latest add skeleton
```

### Step 4: Environment Variables

```bash
# /.env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
NEXT_PUBLIC_BACKEND_URL=https://your-backend.railway.app
```

---

## Part 3: Core Setup Files

### File: `/src/lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Helper: Get current user
export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) throw error
  return user
}

// Helper: Get tenant for current user
export async function getCurrentTenant() {
  const user = await getCurrentUser()
  if (!user) return null
  
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('owner_id', user.id)
    .single()
  
  if (error) throw error
  return data
}
```

### File: `/src/lib/types.ts`

```typescript
export interface Tenant {
  id: string
  owner_id: string
  clinic_name: string
  agent_name: string
  system_prompt: string
  stt_config: Record<string, string>
  llm_config: {
    provider: string
    model: string
  }
  tts_config: Record<string, string>
  wa_phone_number_id?: string
  wa_business_account_id?: string
  wa_access_token?: string
  wa_verify_token?: string
  sip_uri?: string
  escalation_number?: string
  business_hours: BusinessHours
  created_at: string
  updated_at: string
}

export interface BusinessHours {
  monday: { open: string, close: string, closed: boolean }
  tuesday: { open: string, close: string, closed: boolean }
  wednesday: { open: string, close: string, closed: boolean }
  thursday: { open: string, close: string, closed: boolean }
  friday: { open: string, close: string, closed: boolean }
  saturday: { open: string, close: string, closed: boolean }
  sunday: { open: string, close: string, closed: boolean }
}

export interface TenantSettings {
  id: string
  tenant_id: string
  google_calendar_token?: string
  google_calendar_refresh?: string
  google_calendar_id?: string
  google_sheets_token?: string
  google_sheets_refresh?: string
  google_sheets_id?: string
  faq_pairs: Array<{ question: string, answer: string }>
  holidays: string[]
  notification_email?: string
  slack_webhook?: string
  created_at: string
  updated_at: string
}

export interface Booking {
  id: string
  tenant_id: string
  contact_id: string
  service_type: string
  scheduled_at: string
  duration_minutes: number
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  source: 'voice' | 'whatsapp'
  notes?: string
  created_at: string
  updated_at: string
  contact?: Contact
}

export interface Contact {
  id: string
  tenant_id: string
  name: string
  phone: string
  language?: string
  created_at: string
}

export interface Call {
  id: string
  tenant_id: string
  contact_id?: string
  caller_number: string
  duration_seconds: number
  language: string
  outcome: 'booked' | 'faq' | 'escalated' | 'missed'
  transcript: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
  summary?: string
  booking_id?: string
  stt_provider: string
  llm_provider: string
  created_at: string
  contact?: Contact
  booking?: Booking
}

export interface WhatsAppThread {
  id: string
  tenant_id: string
  contact_id: string
  status: 'ai' | 'needs_attention' | 'human'
  last_message_at: string
  unread_count: number
  created_at: string
  contact?: Contact
  messages?: WhatsAppMessage[]
}

export interface WhatsAppMessage {
  id: string
  thread_id: string
  role: 'user' | 'assistant' | 'staff'
  body: string
  created_at: string
}

export interface AnalyticsMetrics {
  call_answer_rate: number
  bookings_this_week: number
  avg_call_duration: number
  wa_messages_handled: number
  ai_handle_rate: number
  escalations: number
}
```

### File: `/src/lib/providers.ts`

```typescript
// Provider options for LLM, STT, TTS pickers

export const LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
    ],
    description: 'Fastest inference, best for real-time voice',
    recommended: true,
    estimatedCostPerCall: '$0.001'
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
    description: 'Most accurate, best for complex conversations',
    estimatedCostPerCall: '$0.005'
  },
  {
    provider: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-20250107', name: 'Claude Haiku 4' },
    ],
    description: 'Nuanced conversations, great at following instructions',
    estimatedCostPerCall: '$0.004'
  },
  {
    provider: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    ],
    description: 'Best for multilingual support',
    estimatedCostPerCall: '$0.002'
  },
]

export const STT_PROVIDERS = {
  en: [
    { id: 'deepgram', name: 'Deepgram Nova-2', recommended: true },
    { id: 'whisper_groq', name: 'Whisper (Groq)' },
    { id: 'assemblyai', name: 'AssemblyAI' },
  ],
  ms: [
    { id: 'whisper_groq', name: 'Whisper (Groq)', recommended: true },
    { id: 'deepgram', name: 'Deepgram' },
  ],
  zh: [
    { id: 'deepgram', name: 'Deepgram', recommended: true },
    { id: 'whisper_groq', name: 'Whisper (Groq)' },
  ],
}

export const TTS_PROVIDERS = {
  en: [
    { id: 'cartesia', name: 'Cartesia (Sonic)', recommended: true },
    { id: 'elevenlabs', name: 'ElevenLabs' },
    { id: 'google', name: 'Google TTS' },
  ],
  ms: [
    { id: 'elevenlabs', name: 'ElevenLabs', recommended: true },
    { id: 'google', name: 'Google TTS' },
  ],
  zh: [
    { id: 'elevenlabs', name: 'ElevenLabs', recommended: true },
    { id: 'google', name: 'Google TTS' },
  ],
}

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'zh', name: 'Mandarin' },
]
```

### File: `/src/lib/api.ts`

```typescript
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL

export async function testWhatsAppConnection(tenantId: string) {
  const res = await fetch(`${BACKEND_URL}/api/whatsapp/test/${tenantId}`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error('Test failed')
  return res.json()
}

export async function testPhoneConnection(tenantId: string) {
  const res = await fetch(`${BACKEND_URL}/api/sip/test/${tenantId}`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error('Test failed')
  return res.json()
}

export async function initiateGoogleCalendarOAuth(tenantId: string) {
  window.location.href = `${BACKEND_URL}/api/integrations/google/auth?tenant_id=${tenantId}&service=calendar`
}

export async function disconnectGoogleCalendar(tenantId: string) {
  const res = await fetch(`${BACKEND_URL}/api/integrations/google/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: tenantId, service: 'calendar' })
  })
  if (!res.ok) throw new Error('Disconnect failed')
  return res.json()
}
```

---

## Part 4: Authentication Pages

### File: `/src/app/(auth)/layout.tsx`

```typescript
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-light via-background to-muted p-4">
      <div className="w-full max-w-md">
        {children}
      </div>
    </div>
  )
}
```

### File: `/src/app/(auth)/login/page.tsx`

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Loader2, Phone } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) throw error

      toast.success('Logged in successfully')
      router.push('/overview')
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-center mb-4">
          <Phone className="h-10 w-10 text-primary" />
        </div>
        <CardTitle className="text-2xl text-center">Welcome back</CardTitle>
        <CardDescription className="text-center">
          Sign in to your clinic dashboard
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleLogin}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="clinic@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="flex items-center justify-between">
            <Link
              href="/forgot-password"
              className="text-sm text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
          <div className="text-sm text-center text-muted-foreground">
            Don't have an account?{' '}
            <Link href="/register" className="text-primary hover:underline">
              Sign up
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  )
}
```

### File: `/src/app/(auth)/register/page.tsx`

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Loader2, Phone } from 'lucide-react'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [clinicName, setClinicName] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      // 1. Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      })

      if (authError) throw authError
      if (!authData.user) throw new Error('User creation failed')

      // 2. Create tenant record
      const { error: tenantError } = await supabase
        .from('tenants')
        .insert({
          owner_id: authData.user.id,
          clinic_name: clinicName,
          agent_name: 'Maya',
          system_prompt: '', // Will be set in onboarding
          stt_config: { en: 'deepgram', ms: 'whisper_groq', zh: 'deepgram' },
          llm_config: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
          tts_config: { en: 'cartesia', ms: 'elevenlabs', zh: 'elevenlabs' },
          business_hours: {
            monday: { open: '09:00', close: '18:00', closed: false },
            tuesday: { open: '09:00', close: '18:00', closed: false },
            wednesday: { open: '09:00', close: '18:00', closed: false },
            thursday: { open: '09:00', close: '18:00', closed: false },
            friday: { open: '09:00', close: '18:00', closed: false },
            saturday: { open: '09:00', close: '13:00', closed: false },
            sunday: { open: '09:00', close: '18:00', closed: true },
          }
        })

      if (tenantError) throw tenantError

      toast.success('Account created! Please check your email to verify.')
      router.push('/login')
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-center mb-4">
          <Phone className="h-10 w-10 text-primary" />
        </div>
        <CardTitle className="text-2xl text-center">Create account</CardTitle>
        <CardDescription className="text-center">
          Start your AI receptionist in minutes
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleRegister}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clinic-name">Clinic Name</Label>
            <Input
              id="clinic-name"
              placeholder="Gigi Maju Dental Clinic"
              value={clinicName}
              onChange={(e) => setClinicName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="clinic@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Min. 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create account
          </Button>
          <div className="text-sm text-center text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  )
}
```

---

## Part 5: Dashboard Layout

### File: `/src/app/(dashboard)/layout.tsx`

```typescript
import { redirect } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import Sidebar from '@/components/dashboard/sidebar'
import Navbar from '@/components/dashboard/navbar'
import { Toaster } from 'sonner'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Check authentication
  const { data: { session } } = await supabase.auth.getSession()
  
  if (!session) {
    redirect('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-muted/30">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Navbar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
      <Toaster position="top-right" />
    </div>
  )
}
```

### File: `/src/components/dashboard/sidebar.tsx`

```typescript
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Calendar,
  ClipboardList,
  Phone,
  MessageSquare,
  BarChart3,
  Settings,
} from 'lucide-react'

const navigation = [
  { name: 'Overview', href: '/overview', icon: LayoutDashboard },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Appointments', href: '/appointments', icon: ClipboardList },
  { name: 'Call Logs', href: '/call-logs', icon: Phone },
  { name: 'WhatsApp', href: '/whatsapp', icon: MessageSquare },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-64 bg-card border-r border-border flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-border">
        <Phone className="h-8 w-8 text-primary" />
        <span className="ml-3 text-lg font-semibold">AI Receptionist</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-6 space-y-1">
        {navigation.map((item) => {
          const isActive = pathname.startsWith(item.href)
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 mr-3" />
              {item.name}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <div className="text-xs text-muted-foreground text-center">
          v1.0.0 • <a href="#" className="hover:text-primary">Help</a>
        </div>
      </div>
    </div>
  )
}
```

### File: `/src/components/dashboard/navbar.tsx`

```typescript
'use client'

import { Bell, Search, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function Navbar() {
  const router = useRouter()

  async function handleLogout() {
    await supabase.auth.signOut()
    toast.success('Logged out successfully')
    router.push('/login')
  }

  return (
    <header className="h-16 border-b border-border bg-card flex items-center justify-between px-6">
      {/* Search */}
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search appointments, calls, contacts..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Notifications */}
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-error" />
        </Button>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <Avatar>
                <AvatarFallback>
                  <User className="h-5 w-5" />
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuItem>Billing</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
```

---

## Part 6: Overview Page

### File: `/src/app/(dashboard)/overview/page.tsx`

```typescript
'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import StatCard from '@/components/dashboard/stat-card'
import LiveIndicator from '@/components/dashboard/live-indicator'
import PluginStatusBar from '@/components/dashboard/plugin-status-bar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Calendar, MessageSquare } from 'lucide-react'
import Link from 'next/link'

export default function OverviewPage() {
  const { data: metrics, isLoading } = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant found')

      // Fetch metrics (implement these queries based on your schema)
      const startOfWeek = new Date()
      startOfWeek.setDate(startOfWeek.getDate() - 7)

      const [bookings, calls, waThreads] = await Promise.all([
        supabase
          .from('bookings')
          .select('*', { count: 'exact' })
          .eq('tenant_id', tenant.id)
          .gte('created_at', startOfWeek.toISOString()),
        supabase
          .from('calls')
          .select('*')
          .eq('tenant_id', tenant.id)
          .gte('created_at', startOfWeek.toISOString()),
        supabase
          .from('wa_threads')
          .select('*')
          .eq('tenant_id', tenant.id)
          .gte('last_message_at', startOfWeek.toISOString()),
      ])

      const totalCalls = calls.data?.length || 0
      const answeredCalls = calls.data?.filter(c => c.outcome !== 'missed').length || 0
      const avgDuration = calls.data?.reduce((sum, c) => sum + c.duration_seconds, 0) / totalCalls || 0
      const escalations = calls.data?.filter(c => c.outcome === 'escalated').length || 0

      const aiHandledThreads = waThreads.data?.filter(t => t.status === 'ai').length || 0
      const totalThreads = waThreads.data?.length || 0

      return {
        callAnswerRate: totalCalls > 0 ? (answeredCalls / totalCalls) * 100 : 0,
        bookingsThisWeek: bookings.count || 0,
        avgCallDuration: Math.round(avgDuration),
        waMessagesHandled: totalThreads,
        aiHandleRate: totalThreads > 0 ? (aiHandledThreads / totalThreads) * 100 : 0,
        escalations,
      }
    },
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Welcome back! Here's what's happening today.</p>
      </div>

      {/* Plugin Status Bar */}
      <PluginStatusBar />

      {/* Live Indicator */}
      <LiveIndicator />

      {/* Metrics Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Call Answer Rate"
          value={`${metrics?.callAnswerRate.toFixed(1)}%`}
          change="+5.2%"
          trend="up"
          icon="phone"
        />
        <StatCard
          title="Appointments Booked"
          value={metrics?.bookingsThisWeek || 0}
          subtitle="This week"
          icon="calendar"
        />
        <StatCard
          title="Avg Call Duration"
          value={`${Math.floor((metrics?.avgCallDuration || 0) / 60)}m ${(metrics?.avgCallDuration || 0) % 60}s`}
          icon="clock"
        />
        <StatCard
          title="WA Messages"
          value={metrics?.waMessagesHandled || 0}
          subtitle="This week"
          icon="message"
        />
        <StatCard
          title="AI Handle Rate"
          value={`${metrics?.aiHandleRate.toFixed(1)}%`}
          change="+2.3%"
          trend="up"
          icon="bot"
        />
        <StatCard
          title="Escalations"
          value={metrics?.escalations || 0}
          subtitle="This week"
          icon="alert"
        />
      </div>

      {/* Recent Activity */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Recent Appointments */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Recent Appointments</span>
              <Link href="/appointments">
                <Button variant="ghost" size="sm">View all</Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Implement recent appointments list */}
            <p className="text-sm text-muted-foreground">No recent appointments</p>
          </CardContent>
        </Card>

        {/* WhatsApp Threads */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>WhatsApp Threads</span>
              <Link href="/whatsapp">
                <Button variant="ghost" size="sm">View inbox</Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Implement WA threads list */}
            <p className="text-sm text-muted-foreground">No threads needing attention</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
```

### File: `/src/components/dashboard/stat-card.tsx`

```typescript
import { Card, CardContent } from '@/components/ui/card'
import { ArrowDown, ArrowUp, Phone, Calendar, Clock, MessageSquare, Bot, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  change?: string
  trend?: 'up' | 'down'
  icon?: 'phone' | 'calendar' | 'clock' | 'message' | 'bot' | 'alert'
}

const icons = {
  phone: Phone,
  calendar: Calendar,
  clock: Clock,
  message: MessageSquare,
  bot: Bot,
  alert: AlertTriangle,
}

export default function StatCard({
  title,
  value,
  subtitle,
  change,
  trend,
  icon = 'phone',
}: StatCardProps) {
  const Icon = icons[icon]

  return (
    <Card className="stat-card-glow hover:shadow-md transition-shadow">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon className="h-5 w-5 text-primary" />
          </div>
        </div>
        <div>
          <p className="text-3xl font-bold">{value}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          )}
          {change && trend && (
            <div className="flex items-center gap-1 mt-2">
              {trend === 'up' ? (
                <ArrowUp className="h-4 w-4 text-success" />
              ) : (
                <ArrowDown className="h-4 w-4 text-error" />
              )}
              <span className={cn(
                'text-sm font-medium',
                trend === 'up' ? 'text-success' : 'text-error'
              )}>
                {change}
              </span>
              <span className="text-xs text-muted-foreground ml-1">vs last week</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
```

### File: `/src/components/dashboard/live-indicator.tsx`

```typescript
'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Phone } from 'lucide-react'
import { supabase, getCurrentTenant } from '@/lib/supabase'

export default function LiveIndicator() {
  const [activeCalls, setActiveCalls] = useState(0)

  useEffect(() => {
    async function subscribe() {
      const tenant = await getCurrentTenant()
      if (!tenant) return

      // Subscribe to active calls
      const channel = supabase
        .channel('active_calls')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'calls',
            filter: `tenant_id=eq.${tenant.id}`,
          },
          (payload) => {
            // Update active calls count
            // This is simplified - implement proper logic based on your schema
            setActiveCalls((prev) => {
              if (payload.eventType === 'INSERT') return prev + 1
              if (payload.eventType === 'DELETE') return Math.max(0, prev - 1)
              return prev
            })
          }
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }

    subscribe()
  }, [])

  if (activeCalls === 0) return null

  return (
    <Card className="bg-success-light border-success">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Phone className="h-6 w-6 text-success" />
            <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-success animate-pulse" />
          </div>
          <div>
            <p className="font-semibold text-success">
              {activeCalls} Active Call{activeCalls !== 1 ? 's' : ''}
            </p>
            <p className="text-sm text-success/80">AI is handling incoming calls right now</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

### File: `/src/components/dashboard/plugin-status-bar.tsx`

```typescript
'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, Settings } from 'lucide-react'
import Link from 'next/link'

export default function PluginStatusBar() {
  const { data: status } = useQuery({
    queryKey: ['plugin-status'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant found')

      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('*')
        .eq('tenant_id', tenant.id)
        .single()

      return {
        whatsapp: !!tenant.wa_phone_number_id,
        phone: !!tenant.sip_uri,
        calendar: !!settings?.google_calendar_token,
        agent: !!tenant.system_prompt,
      }
    },
  })

  const plugins = [
    { name: 'WhatsApp', connected: status?.whatsapp, href: '/settings/plugins/whatsapp' },
    { name: 'Phone', connected: status?.phone, href: '/settings/plugins/phone' },
    { name: 'Calendar', connected: status?.calendar, href: '/settings/plugins/calendar' },
    { name: 'Agent', connected: status?.agent, href: '/settings/plugins/agent' },
  ]

  const disconnectedCount = plugins.filter(p => !p.connected).length

  if (disconnectedCount === 0) return null

  return (
    <Card className="bg-warning-light border-warning">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-warning-foreground">
              {disconnectedCount} Plugin{disconnectedCount !== 1 ? 's' : ''} Not Connected
            </p>
            <div className="flex gap-2 mt-2">
              {plugins.map((plugin) => (
                <Badge
                  key={plugin.name}
                  variant={plugin.connected ? 'default' : 'secondary'}
                  className="gap-1"
                >
                  {plugin.connected ? (
                    <CheckCircle2 className="h-3 w-3 text-success" />
                  ) : (
                    <XCircle className="h-3 w-3 text-error" />
                  )}
                  {plugin.name}
                </Badge>
              ))}
            </div>
          </div>
          <Link href="/settings">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              Configure
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
```

---

## Part 7: Settings - WhatsApp Plugin

### File: `/src/app/(dashboard)/settings/plugins/whatsapp/page.tsx`

```typescript
'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { testWhatsAppConnection } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Copy, ExternalLink, Loader2 } from 'lucide-react'
import Link from 'next/link'

export default function WhatsAppPluginPage() {
  const queryClient = useQueryClient()
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [businessAccountId, setBusinessAccountId] = useState('')
  const [accessToken, setAccessToken] = useState('')

  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
  })

  const isConnected = !!tenant?.wa_phone_number_id

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      
      // Generate verify token
      const verifyToken = `verify_${tenant.id.slice(0, 8)}`

      const { error } = await supabase
        .from('tenants')
        .update({
          wa_phone_number_id: phoneNumberId,
          wa_business_account_id: businessAccountId,
          wa_access_token: accessToken,
          wa_verify_token: verifyToken,
        })
        .eq('id', tenant.id)

      if (error) throw error
    },
    onSuccess: () => {
      toast.success('WhatsApp connected successfully')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
    },
    onError: (error: any) => {
      toast.error(error.message)
    },
  })

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      return testWhatsAppConnection(tenant.id)
    },
    onSuccess: () => {
      toast.success('Test message sent successfully')
    },
    onError: (error: any) => {
      toast.error('Test failed: ' + error.message)
    },
  })

  const webhookUrl = tenant
    ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/webhook/whatsapp/${tenant.id}`
    : ''
  const verifyToken = tenant?.wa_verify_token || ''

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
        <p className="text-muted-foreground">
          Connect your WhatsApp Business account to receive messages
        </p>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>
                {isConnected ? 'Your WhatsApp is connected' : 'Not connected yet'}
              </CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Connected
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4" />
                  Disconnected
                </>
              )}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && (
          <CardContent>
            <div className="space-y-2">
              <p className="text-sm"><span className="font-medium">Phone Number ID:</span> {tenant?.wa_phone_number_id}</p>
              <p className="text-sm"><span className="font-medium">Business Account ID:</span> {tenant?.wa_business_account_id}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Test Message
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Setup Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Setup Instructions</CardTitle>
          <CardDescription>
            Follow these steps to connect your WhatsApp Business account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Step 1 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                1
              </div>
              <h3 className="font-semibold">Get your credentials from Meta</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-2 ml-8">
              Go to{' '}
              <a
                href="https://business.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                Meta Business Suite
                <ExternalLink className="h-3 w-3" />
              </a>
              {' '}→ WhatsApp → API Setup
            </p>
          </div>

          <Separator />

          {/* Step 2 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                2
              </div>
              <h3 className="font-semibold">Paste your credentials below</h3>
            </div>
            <div className="space-y-4 ml-8">
              <div className="space-y-2">
                <Label htmlFor="phone-number-id">Phone Number ID</Label>
                <Input
                  id="phone-number-id"
                  placeholder="123456789012345"
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  disabled={isConnected}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-account-id">WhatsApp Business Account ID</Label>
                <Input
                  id="business-account-id"
                  placeholder="987654321098765"
                  value={businessAccountId}
                  onChange={(e) => setBusinessAccountId(e.target.value)}
                  disabled={isConnected}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="access-token">Permanent Access Token</Label>
                <Input
                  id="access-token"
                  type="password"
                  placeholder="EAA..."
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  disabled={isConnected}
                />
              </div>
              {!isConnected && (
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !phoneNumberId || !businessAccountId || !accessToken}
                >
                  {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save & Connect
                </Button>
              )}
            </div>
          </div>

          <Separator />

          {/* Step 3 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                3
              </div>
              <h3 className="font-semibold">Configure webhook in Meta</h3>
            </div>
            <div className="space-y-4 ml-8">
              <div className="space-y-2">
                <Label>Callback URL</Label>
                <div className="flex gap-2">
                  <Input value={webhookUrl} readOnly />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(webhookUrl)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Verify Token</Label>
                <div className="flex gap-2">
                  <Input value={verifyToken} readOnly />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(verifyToken)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="bg-muted/50 p-4 rounded-md">
                <p className="text-sm text-muted-foreground">
                  <strong>Important:</strong> Go back to Meta Business Suite → WhatsApp → Configuration → Webhook → Edit
                  <br />
                  Paste the Callback URL and Verify Token above, then click "Verify and Save"
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```

---

**This document continues with more sections. Due to length, I'll create it as a file and then provide the remaining critical sections in follow-up sections.**

Let me save this first part and continue:

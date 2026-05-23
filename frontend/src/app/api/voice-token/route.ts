import { NextRequest, NextResponse } from 'next/server'

const raw = (process.env.VOICEAI_URL || '').trim().replace(/\/$/, '')
const VOICEAI_URL = raw && !raw.startsWith('http') ? `https://${raw}` : raw

export async function POST(req: NextRequest) {
  if (!VOICEAI_URL) {
    return NextResponse.json(
      { detail: 'VOICEAI_URL is not set. Add it to your Vercel environment variables.' },
      { status: 503 }
    )
  }

  try {
    const body = await req.json()
    const upstream = await fetch(`${VOICEAI_URL}/api/voice-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await upstream.json().catch(() => ({ detail: `VoiceAI backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.status })
  } catch (err) {
    return NextResponse.json(
      { detail: `Could not reach VoiceAI backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}

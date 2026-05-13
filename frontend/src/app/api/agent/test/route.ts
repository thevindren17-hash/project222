import { NextRequest, NextResponse } from 'next/server'

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || ''

export async function POST(req: NextRequest) {
  if (!BACKEND) {
    return NextResponse.json(
      { detail: 'BACKEND_URL is not set. Add it to your Vercel environment variables.' },
      { status: 503 }
    )
  }

  try {
    const body = await req.json()
    const upstream = await fetch(`${BACKEND}/api/agent/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await upstream.json().catch(() => ({ detail: `Backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.status })
  } catch (err) {
    return NextResponse.json(
      { detail: `Could not reach backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}

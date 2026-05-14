import { NextRequest, NextResponse } from 'next/server'

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || ''

export async function GET(req: NextRequest) {
  if (!BACKEND) {
    return NextResponse.json(
      { detail: 'BACKEND_URL is not set. Add it to your Vercel environment variables.' },
      { status: 503 }
    )
  }
  const { searchParams } = new URL(req.url)
  const upstream = `${BACKEND}/api/integrations/google/auth?${searchParams.toString()}`
  return NextResponse.redirect(upstream)
}

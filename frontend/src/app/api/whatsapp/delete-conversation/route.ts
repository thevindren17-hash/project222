import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function DELETE(req: Request) {
  try {
    const { threadId } = await req.json()
    if (!threadId) return NextResponse.json({ error: 'threadId required' }, { status: 400 })

    // Delete all messages first (FK constraint)
    const { error: msgErr } = await supabaseAdmin
      .from('messages')
      .delete()
      .eq('thread_id', threadId)

    if (msgErr) throw msgErr

    // Delete the thread itself
    const { error: threadErr } = await supabaseAdmin
      .from('whatsapp_threads')
      .delete()
      .eq('id', threadId)

    if (threadErr) throw threadErr

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

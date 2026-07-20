import { NextResponse } from 'next/server'
import { supabaseAdmin, verifyTenantAccess } from '@/lib/server/verify-tenant-access'

export async function DELETE(req: Request) {
  try {
    const { threadId } = await req.json()
    if (!threadId) return NextResponse.json({ error: 'threadId required' }, { status: 400 })

    // Look up which tenant this thread belongs to, then confirm the caller
    // actually owns/staffs that tenant before deleting anything.
    const { data: thread } = await supabaseAdmin
      .from('whatsapp_threads')
      .select('id, tenant_id')
      .eq('id', threadId)
      .maybeSingle()
    if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

    if (!(await verifyTenantAccess(thread.tenant_id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

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

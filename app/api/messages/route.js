import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { database, ensureSchema } from "../../../lib/db";

// How many messages we hand to the thread view. WhatsApp itself only exposes a
// bounded slice of history, so the UI says "Sync limit reached" whenever the
// stored conversation is longer than this window.
const LIMIT = 500;

export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!conversationId) return NextResponse.json({ error: "conversationId is required." }, { status: 400 });
    await ensureSchema();
    const q = database();
    // Scope by workspace so a signed-in user can only read their own threads.
    const [conversation] = await q`SELECT id FROM tl_conversations WHERE id=${conversationId} AND workspace_id=${user.workspace_id}`;
    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    const [counted] = await q`SELECT count(*)::int AS total FROM tl_messages WHERE conversation_id=${conversationId}`;
    const total = counted?.total || 0;
    // Take the newest slice, then flip to chronological order for rendering.
    const rows = await q`SELECT id,direction,body,sent_at,media_id,media_kind,media_name,media_mime,media_size,media_state FROM tl_messages WHERE conversation_id=${conversationId} ORDER BY sent_at DESC, id DESC LIMIT ${LIMIT}`;
    return NextResponse.json({ messages: rows.reverse(), total, limit: LIMIT, limited: total > LIMIT });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load messages." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

// User tapped "Download" on an attachment. We can't fetch it here — the bytes
// only exist on WhatsApp's servers and can only be decrypted by the paired
// laptop — so flag it and let the local adapter pick it up on its next poll.
// The thread already polls, so the preview appears on its own once it lands.
export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const { messageId } = await request.json();
    if (!messageId) return NextResponse.json({ error: "messageId is required." }, { status: 400 });
    await ensureSchema();
    const q = database();

    const [message] = await q`SELECT m.id,m.media_id,m.media_state,m.wa_key
      FROM tl_messages m JOIN tl_conversations c ON c.id=m.conversation_id
      WHERE m.id=${messageId} AND c.workspace_id=${user.workspace_id}`;
    if (!message) return NextResponse.json({ error: "Message not found." }, { status: 404 });
    if (message.media_id) return NextResponse.json({ ok: true, state: "ready" });
    if (!message.wa_key) return NextResponse.json({ ok: false, state: "unavailable", error: "This attachment predates media sync and can no longer be fetched." });

    await q`UPDATE tl_messages SET media_state='requested' WHERE id=${messageId}`;
    return NextResponse.json({ ok: true, state: "requested" });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not request the attachment." }, { status: 500 });
  }
}

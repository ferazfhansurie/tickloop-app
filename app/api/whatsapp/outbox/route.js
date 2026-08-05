import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { database, ensureSchema } from "../../../../lib/db";

function tokenFrom(request) { const value = request.headers.get("authorization") || ""; return value.startsWith("Bearer ") ? value.slice(7) : null; }
async function worker(request) {
  const token = tokenFrom(request); if (!token) return null;
  await ensureSchema(); const q = database(); const hash = createHash("sha256").update(token).digest("hex");
  const connection = (await q`SELECT workspace_id FROM tl_connections WHERE provider='whatsapp' AND metadata->>'workerTokenHash'=${hash} LIMIT 1`)[0];
  return connection ? { q, connection } : null;
}

export async function GET(request) {
  try {
    const auth = await worker(request); if (!auth) return NextResponse.json({ error: "Worker token required." }, { status: 401 });
    const item = (await auth.q`SELECT id,phone,body,recipient,media_base64,media_mime,media_name,media_kind FROM tl_outbox WHERE workspace_id=${auth.connection.workspace_id} AND status='queued' ORDER BY created_at LIMIT 1`)[0];
    if (!item) return NextResponse.json({ item: null });
    await auth.q`UPDATE tl_outbox SET status='sending' WHERE id=${item.id} AND status='queued'`;
    return NextResponse.json({ item });
  } catch (error) { return NextResponse.json({ error: error.message || "Could not load outbox." }, { status: 500 }); }
}

export async function POST(request) {
  try {
    const auth = await worker(request); if (!auth) return NextResponse.json({ error: "Worker token required." }, { status: 401 });
    const { id, status, externalId, error } = await request.json();
    if (!id || !["sent", "failed"].includes(status)) return NextResponse.json({ error: "Invalid delivery update." }, { status: 400 });
    const item = (await auth.q`SELECT * FROM tl_outbox WHERE id=${id} AND workspace_id=${auth.connection.workspace_id} LIMIT 1`)[0];
    if (!item) return NextResponse.json({ error: "Outbox message not found." }, { status: 404 });
    await auth.q`UPDATE tl_outbox SET status=${status},external_id=${externalId || null},error=${error || null},sent_at=CASE WHEN ${status}='sent' THEN now() ELSE NULL END WHERE id=${id}`;
    if (status === "sent") {
      // Replies sent from a thread already know their conversation. Only the
      // legacy "send to a bare number" path has to synthesise one.
      let conversationId = item.conversation_id;
      if (!conversationId) {
        const chatId = `${item.phone}@c.us`;
        conversationId = `cv_${createHash("sha256").update(`${auth.connection.workspace_id}:${chatId}`).digest("hex").slice(0, 24)}`;
        await auth.q`INSERT INTO tl_conversations (id,workspace_id,provider,external_id,customer_name,customer_phone,last_message_at) VALUES (${conversationId},${auth.connection.workspace_id},'whatsapp',${chatId},${item.phone},${`+${item.phone}`},now()) ON CONFLICT (workspace_id,provider,external_id) DO UPDATE SET last_message_at=now()`;
      } else {
        await auth.q`UPDATE tl_conversations SET last_message_at=now() WHERE id=${conversationId}`;
      }
      // Keep a copy of anything we sent so the thread shows the attachment too.
      let mediaId = null;
      if (item.media_base64) {
        const bytes = Buffer.from(item.media_base64, "base64");
        mediaId = `md_${randomBytes(12).toString("hex")}`;
        await auth.q`INSERT INTO tl_media (id,workspace_id,mime_type,file_name,size_bytes,data) VALUES (${mediaId},${auth.connection.workspace_id},${item.media_mime || "application/octet-stream"},${item.media_name || null},${bytes.length},${bytes})`;
      }
      await auth.q`INSERT INTO tl_messages (id,conversation_id,external_id,direction,body,media_id,media_kind,media_name,media_mime)
        VALUES (${`msg_${randomBytes(12).toString("hex")}`},${conversationId},${externalId || `out_${id}`},'outbound',${item.body},${mediaId},${item.media_kind || null},${item.media_name || null},${item.media_mime || null})
        ON CONFLICT (external_id) DO NOTHING`;
      // Drop the queued copy of the bytes; the durable copy now lives in tl_media.
      await auth.q`UPDATE tl_outbox SET media_base64=NULL WHERE id=${id}`;
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error.message || "Could not update delivery." }, { status: 500 }); }
}

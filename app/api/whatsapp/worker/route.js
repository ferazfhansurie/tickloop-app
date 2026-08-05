import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

export async function POST(request) {
  try {
    const token = bearer(request);
    if (!token) return NextResponse.json({ error: "Worker token required." }, { status: 401 });
    await ensureSchema();
    const q = database();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const connections = await q`SELECT id,workspace_id,status,metadata FROM tl_connections WHERE provider='whatsapp' AND metadata->>'workerTokenHash'=${tokenHash} LIMIT 1`;
    const connection = connections[0];
    if (!connection) return NextResponse.json({ error: "Worker token is invalid." }, { status: 401 });
    if (connection.status !== "connected" && connection.metadata?.pairExpiresAt && Date.parse(connection.metadata.pairExpiresAt) < Date.now()) return NextResponse.json({ error: "Pairing token expired. Start WhatsApp setup again." }, { status: 401 });
    const body = await request.json();
    if (body.type === "qr") {
      if (typeof body.qrDataUrl !== "string" || !body.qrDataUrl.startsWith("data:image/") || body.qrDataUrl.length > 500000) return NextResponse.json({ error: "Invalid QR code payload." }, { status: 400 });
      await q`UPDATE tl_connections SET metadata=metadata || ${JSON.stringify({ qrDataUrl: body.qrDataUrl })}::jsonb,updated_at=now() WHERE id=${connection.id}`;
      return NextResponse.json({ ok: true });
    }
    if (body.type === "status") {
      // An existing LocalAuth session emits "authenticated" on every worker restart.
      // Keep a healthy connection connected until WhatsApp explicitly reports a disconnect.
      const status = body.status === "ready" ? "connected" : body.status === "disconnected" ? "pending" : connection.status === "connected" ? "connected" : "pairing";
      await q`UPDATE tl_connections SET status=${status},external_id=${body.phone || null},metadata=CASE WHEN ${status}='connected' THEN metadata - 'qrDataUrl' ELSE metadata END,updated_at=now() WHERE id=${connection.id}`;
      return NextResponse.json({ ok: true, status });
    }
    if (body.type === "sync_status") {
      const rawError = String(body.error || "").trim();
      const syncError = rawError.length < 8 ? "WhatsApp Web is not ready to expose existing chat history yet. TickLoop will retry automatically." : rawError.slice(0, 180);
      const metadata = { ...(connection.metadata || {}), syncStatus: body.status || "syncing", syncImported: Number(body.imported) || 0, syncTotal: Number(body.total) || 0, lastSyncAt: new Date().toISOString(), ...(body.error ? { lastSyncError: syncError } : {}) };
      if (body.status === "complete") delete metadata.lastSyncError;
      await q`UPDATE tl_connections SET metadata=${JSON.stringify(metadata)}::jsonb,updated_at=now() WHERE id=${connection.id}`;
      return NextResponse.json({ ok: true });
    }
    // WhatsApp now addresses many chats by a hidden "@lid" handle instead of the
    // phone JID, so the same human can arrive twice: once as 28347136504059@lid
    // (carrying all the history) and once as 601121677522@s.whatsapp.net (a stub
    // from a live message). Neither Evolution's DB nor its API exposes the
    // lid<->phone mapping, so we reconcile on the display name: when a phone-JID
    // chat matches an existing @lid conversation by name, reuse that conversation
    // and let it adopt the real phone number.
    if (body.type === "merge_duplicates") {
      const merged = await mergeDuplicateConversations(q, connection.workspace_id);
      return NextResponse.json({ ok: true, merged });
    }
    if (body.type === "message") {
      if (!body.messageId || !body.chatId || typeof body.body !== "string") return NextResponse.json({ error: "Invalid message payload." }, { status: 400 });
      const conversationId = `cv_${createHash("sha256").update(`${connection.workspace_id}:${body.chatId}`).digest("hex").slice(0, 24)}`;
      await q`INSERT INTO tl_conversations (id,workspace_id,provider,external_id,customer_name,customer_phone,last_message_at) VALUES (${conversationId},${connection.workspace_id},'whatsapp',${body.chatId},${body.pushName || null},${body.phone || null},to_timestamp(${body.timestamp || Math.floor(Date.now() / 1000)})) ON CONFLICT (workspace_id,provider,external_id) DO UPDATE SET customer_name=COALESCE(EXCLUDED.customer_name,tl_conversations.customer_name),customer_phone=COALESCE(EXCLUDED.customer_phone,tl_conversations.customer_phone),last_message_at=EXCLUDED.last_message_at`;
      await q`INSERT INTO tl_messages (id,conversation_id,external_id,direction,body,sent_at) VALUES (${`msg_${randomBytes(12).toString("hex")}`},${conversationId},${body.messageId},'inbound',${body.body},to_timestamp(${body.timestamp || Math.floor(Date.now() / 1000)})) ON CONFLICT (external_id) DO NOTHING`;
      return NextResponse.json({ ok: true });
    }
    if (body.type === "sync") {
      const chat = body.chat || {}; if (!chat.chatId || !Array.isArray(chat.messages)) return NextResponse.json({ error: "Invalid chat sync payload." }, { status: 400 });
      const conversationId = `cv_${createHash("sha256").update(`${connection.workspace_id}:${chat.chatId}`).digest("hex").slice(0, 24)}`;
      const timestamp = Number(chat.timestamp) || Math.floor(Date.now() / 1000);
      await q`INSERT INTO tl_conversations (id,workspace_id,provider,external_id,customer_name,customer_phone,avatar_url,last_message_at) VALUES (${conversationId},${connection.workspace_id},'whatsapp',${chat.chatId},${chat.name || null},${chat.phone || null},${chat.avatarUrl || null},to_timestamp(${timestamp})) ON CONFLICT (workspace_id,provider,external_id) DO UPDATE SET customer_name=COALESCE(EXCLUDED.customer_name,tl_conversations.customer_name),customer_phone=COALESCE(EXCLUDED.customer_phone,tl_conversations.customer_phone),avatar_url=COALESCE(EXCLUDED.avatar_url,tl_conversations.avatar_url),last_message_at=GREATEST(EXCLUDED.last_message_at,tl_conversations.last_message_at)`;
      // The adapter already chunks history (150/call); slicing to 50 here silently
      // dropped two thirds of every backfill batch.
      for (const message of chat.messages) {
        if (!message.id || typeof message.body !== "string") continue;
        await q`INSERT INTO tl_messages (id,conversation_id,external_id,direction,body,sent_at) VALUES (${`msg_${randomBytes(12).toString("hex")}`},${conversationId},${message.id},${message.fromMe ? "outbound" : "inbound"},${message.body},to_timestamp(${Number(message.timestamp) || timestamp})) ON CONFLICT (external_id) DO NOTHING`;
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unsupported worker event." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Worker event failed." }, { status: 500 });
  }
}

// Collapse conversations that are the same person seen under two WhatsApp
// identities (an @lid handle and a real phone JID). Keeps the conversation with
// the most messages — that is the one holding the imported history — moves the
// other's messages into it, and adopts the real phone number / avatar. Also
// clears any "phone" that is really just @lid digits, so the inbox stops showing
// a 15-digit handle where a number belongs. Safe to re-run.
async function mergeDuplicateConversations(q, workspaceId) {
  // A LID is not a dialable number; never present one as the contact's phone.
  await q`UPDATE tl_conversations SET customer_phone=NULL
    WHERE workspace_id=${workspaceId} AND external_id LIKE '%@lid'
      AND customer_phone IS NOT NULL AND customer_phone = split_part(external_id,'@',1)`;

  // Group by display name, ignoring the generic placeholder (many unrelated
  // contacts share it, so merging on it would fuse different people).
  const groups = await q`SELECT customer_name FROM tl_conversations
    WHERE workspace_id=${workspaceId} AND provider='whatsapp'
      AND customer_name IS NOT NULL AND btrim(customer_name) <> ''
      AND customer_name NOT IN ('WhatsApp contact','Customer')
    GROUP BY customer_name HAVING count(*) > 1`;

  let merged = 0;
  for (const group of groups) {
    const rows = await q`SELECT c.id, c.external_id, c.customer_phone, c.avatar_url,
        (SELECT count(*) FROM tl_messages m WHERE m.conversation_id=c.id)::int AS msgs
      FROM tl_conversations c
      WHERE c.workspace_id=${workspaceId} AND c.provider='whatsapp' AND c.customer_name=${group.customer_name}
      ORDER BY msgs DESC, c.created_at ASC`;
    if (rows.length < 2) continue;

    const keeper = rows[0];
    const losers = rows.slice(1);
    // Prefer a real phone number from whichever row actually has one.
    const phone = [keeper, ...losers].map(r => r.customer_phone)
      .find(value => value && !/^\d{13,}$/.test(value)) || null;
    const avatar = [keeper, ...losers].map(r => r.avatar_url).find(Boolean) || null;

    for (const loser of losers) {
      await q`UPDATE tl_messages SET conversation_id=${keeper.id} WHERE conversation_id=${loser.id}`;
      await q`DELETE FROM tl_conversations WHERE id=${loser.id}`;
      merged += 1;
    }
    await q`UPDATE tl_conversations SET
        customer_phone=COALESCE(${phone},customer_phone),
        avatar_url=COALESCE(${avatar},avatar_url),
        last_message_at=(SELECT max(sent_at) FROM tl_messages WHERE conversation_id=${keeper.id})
      WHERE id=${keeper.id}`;
  }
  return merged;
}

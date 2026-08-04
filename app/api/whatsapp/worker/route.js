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
      const status = body.status === "ready" ? "connected" : body.status === "disconnected" ? "pending" : "pairing";
      await q`UPDATE tl_connections SET status=${status},external_id=${body.phone || null},metadata=CASE WHEN ${status}='connected' THEN metadata - 'qrDataUrl' ELSE metadata END,updated_at=now() WHERE id=${connection.id}`;
      return NextResponse.json({ ok: true, status });
    }
    if (body.type === "message") {
      if (!body.messageId || !body.chatId || typeof body.body !== "string") return NextResponse.json({ error: "Invalid message payload." }, { status: 400 });
      const conversationId = `cv_${createHash("sha256").update(`${connection.workspace_id}:${body.chatId}`).digest("hex").slice(0, 24)}`;
      await q`INSERT INTO tl_conversations (id,workspace_id,provider,external_id,customer_name,customer_phone,last_message_at) VALUES (${conversationId},${connection.workspace_id},'whatsapp',${body.chatId},${body.pushName || null},${body.phone || null},to_timestamp(${body.timestamp || Math.floor(Date.now() / 1000)})) ON CONFLICT (workspace_id,provider,external_id) DO UPDATE SET customer_name=COALESCE(EXCLUDED.customer_name,tl_conversations.customer_name),customer_phone=COALESCE(EXCLUDED.customer_phone,tl_conversations.customer_phone),last_message_at=EXCLUDED.last_message_at`;
      await q`INSERT INTO tl_messages (id,conversation_id,external_id,direction,body,sent_at) VALUES (${`msg_${randomBytes(12).toString("hex")}`},${conversationId},${body.messageId},'inbound',${body.body},to_timestamp(${body.timestamp || Math.floor(Date.now() / 1000)})) ON CONFLICT (external_id) DO NOTHING`;
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unsupported worker event." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Worker event failed." }, { status: 500 });
  }
}

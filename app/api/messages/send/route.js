import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";
// Attachments travel as base64 in the JSON body.
export const maxDuration = 60;

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Queue an outbound WhatsApp message (text and/or one attachment) against a
// conversation. The local adapter drains tl_outbox and sends it through
// Evolution, then reports back so the message appears in the thread.
//
// Also handles forwarding: pass `mediaId` to re-send an attachment we already
// captured, without the browser having to re-upload it.
export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const q = database();
    const { conversationId, body = "", media = null, mediaId = null } = await request.json();
    if (!conversationId) return NextResponse.json({ error: "conversationId is required." }, { status: 400 });

    const [conversation] = await q`SELECT id,external_id,customer_phone,provider FROM tl_conversations WHERE id=${conversationId} AND workspace_id=${user.workspace_id}`;
    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    if (conversation.provider !== "whatsapp") return NextResponse.json({ error: "Only WhatsApp conversations can be replied to." }, { status: 400 });

    const text = String(body || "").slice(0, 4096);

    // Resolve the attachment: either uploaded now, or an existing captured one
    // being forwarded.
    let attachment = null;
    if (mediaId) {
      const [stored] = await q`SELECT id,mime_type,file_name,size_bytes,data FROM tl_media WHERE id=${mediaId} AND workspace_id=${user.workspace_id}`;
      if (!stored) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
      const bytes = Buffer.isBuffer(stored.data) ? stored.data : Buffer.from(stored.data);
      attachment = { base64: bytes.toString("base64"), mime: stored.mime_type, name: stored.file_name, kind: kindFromMime(stored.mime_type) };
    } else if (media?.base64) {
      const approxBytes = Math.round((media.base64.length * 3) / 4);
      if (approxBytes > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: "Attachment is larger than 8 MB." }, { status: 413 });
      attachment = { base64: media.base64, mime: media.mime || "application/octet-stream", name: media.name || "file", kind: kindFromMime(media.mime || "") };
    }

    if (!text.trim() && !attachment) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });

    // Evolution accepts a full JID as the recipient, which matters for @lid
    // contacts where we have no phone number at all.
    const recipient = conversation.external_id || (conversation.customer_phone ? `${conversation.customer_phone}@s.whatsapp.net` : null);
    if (!recipient) return NextResponse.json({ error: "This contact has no reachable WhatsApp address." }, { status: 400 });

    const id = `out_${randomBytes(12).toString("hex")}`;
    await q`INSERT INTO tl_outbox (id,workspace_id,phone,body,status,conversation_id,recipient,media_base64,media_mime,media_name,media_kind)
      VALUES (${id},${user.workspace_id},${conversation.customer_phone || recipient.replace(/@.+$/, "")},${text},'queued',${conversation.id},${recipient},${attachment?.base64 || null},${attachment?.mime || null},${attachment?.name || null},${attachment?.kind || null})`;

    return NextResponse.json({ ok: true, queuedId: id });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not queue the message." }, { status: 500 });
  }
}

function kindFromMime(mime) {
  if (mime.startsWith("image/")) return mime.includes("webp") ? "sticker" : "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

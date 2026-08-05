import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

async function worker(request) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : null;
  if (!token) return null;
  await ensureSchema();
  const q = database();
  const hash = createHash("sha256").update(token).digest("hex");
  const connection = (await q`SELECT workspace_id FROM tl_connections WHERE provider='whatsapp' AND metadata->>'workerTokenHash'=${hash} LIMIT 1`)[0];
  return connection ? { q, workspaceId: connection.workspace_id } : null;
}

// The adapter polls this for attachments the user asked to download.
export async function GET(request) {
  try {
    const auth = await worker(request);
    if (!auth) return NextResponse.json({ error: "Worker token required." }, { status: 401 });
    const items = await auth.q`SELECT m.id,m.wa_key,m.media_kind
      FROM tl_messages m JOIN tl_conversations c ON c.id=m.conversation_id
      WHERE c.workspace_id=${auth.workspaceId} AND m.media_state='requested' AND m.media_id IS NULL AND m.wa_key IS NOT NULL
      ORDER BY m.sent_at DESC LIMIT 5`;
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load the media queue." }, { status: 500 });
  }
}

// The adapter returns the decrypted bytes (or reports it is gone for good).
export async function POST(request) {
  try {
    const auth = await worker(request);
    if (!auth) return NextResponse.json({ error: "Worker token required." }, { status: 401 });
    const { messageId, media, unavailable } = await request.json();
    if (!messageId) return NextResponse.json({ error: "messageId is required." }, { status: 400 });

    const [message] = await auth.q`SELECT m.id FROM tl_messages m JOIN tl_conversations c ON c.id=m.conversation_id
      WHERE m.id=${messageId} AND c.workspace_id=${auth.workspaceId}`;
    if (!message) return NextResponse.json({ error: "Message not found." }, { status: 404 });

    if (unavailable || !media?.base64) {
      // WhatsApp expires media; mark it so the UI stops offering a download.
      await auth.q`UPDATE tl_messages SET media_state='unavailable' WHERE id=${messageId}`;
      return NextResponse.json({ ok: true, state: "unavailable" });
    }

    const bytes = Buffer.from(media.base64, "base64");
    if (!bytes.length || bytes.length > MEDIA_MAX_BYTES) {
      await auth.q`UPDATE tl_messages SET media_state='unavailable' WHERE id=${messageId}`;
      return NextResponse.json({ ok: true, state: "unavailable" });
    }
    const mediaId = `md_${randomBytes(12).toString("hex")}`;
    await auth.q`INSERT INTO tl_media (id,workspace_id,mime_type,file_name,size_bytes,data)
      VALUES (${mediaId},${auth.workspaceId},${media.mime || "application/octet-stream"},${media.name || null},${bytes.length},${bytes})`;
    await auth.q`UPDATE tl_messages SET media_id=${mediaId},media_state='ready',
        media_kind=COALESCE(media_kind,${media.kind || null}),
        media_name=COALESCE(media_name,${media.name || null}),
        media_mime=COALESCE(media_mime,${media.mime || null}),
        media_size=COALESCE(media_size,${bytes.length})
      WHERE id=${messageId}`;
    return NextResponse.json({ ok: true, state: "ready" });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not store the attachment." }, { status: 500 });
  }
}

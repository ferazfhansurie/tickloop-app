import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

// Serves captured WhatsApp media. Workspace-scoped: a signed-in user can only
// read attachments belonging to their own workspace.
export async function GET(request, { params }) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const { id } = await params;
    await ensureSchema();
    const rows = await database()`SELECT mime_type,file_name,size_bytes,data FROM tl_media WHERE id=${id} AND workspace_id=${user.workspace_id}`;
    const file = rows[0];
    if (!file) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const disposition = /^(image|video|audio)\//.test(file.mime_type) ? "inline" : "attachment";
    return new NextResponse(bytes, {
      headers: {
        "content-type": file.mime_type || "application/octet-stream",
        "content-length": String(bytes.length),
        "content-disposition": `${disposition}; filename="${(file.file_name || id).replace(/"/g, "")}"`,
        // Media is immutable once captured, and the id is unguessable.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load media." }, { status: 500 });
  }
}

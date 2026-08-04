import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const q = database();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const metadata = { workerTokenHash: tokenHash, pairExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), worker: "whatsapp-web.js" };
    const id = `con_${randomBytes(12).toString("hex")}`;
    await q`INSERT INTO tl_connections (id,workspace_id,provider,status,metadata) VALUES (${id},${user.workspace_id},'whatsapp','pairing',${JSON.stringify(metadata)}::jsonb) ON CONFLICT (workspace_id,provider) DO UPDATE SET status='pairing',metadata=EXCLUDED.metadata,updated_at=now()`;
    return NextResponse.json({ token, appUrl: new URL(request.url).origin, expiresAt: metadata.pairExpiresAt });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not begin WhatsApp pairing." }, { status: 500 });
  }
}

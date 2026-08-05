import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser, decryptCredentials, encryptCredentials } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const q = database();
    const existing = (await q`SELECT id,status,metadata,credentials FROM tl_connections WHERE workspace_id=${user.workspace_id} AND provider='whatsapp' LIMIT 1`)[0];
    if (existing?.status === "connected") return NextResponse.json({ alreadyConnected: true, appUrl: new URL(request.url).origin });
    const savedToken = decryptCredentials(existing?.credentials)?.workerToken;
    if (savedToken) {
      const metadata = { ...(existing.metadata || {}), workerTokenHash: createHash("sha256").update(savedToken).digest("hex"), pairExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), worker: "evolution-api" };
      await q`UPDATE tl_connections SET status='pairing',metadata=${JSON.stringify(metadata)}::jsonb,updated_at=now() WHERE id=${existing.id}`;
      return NextResponse.json({ token: savedToken, appUrl: new URL(request.url).origin, expiresAt: metadata.pairExpiresAt });
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const metadata = { workerTokenHash: tokenHash, pairExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), worker: "evolution-api" };
    const id = `con_${randomBytes(12).toString("hex")}`;
    await q`INSERT INTO tl_connections (id,workspace_id,provider,status,metadata,credentials) VALUES (${id},${user.workspace_id},'whatsapp','pairing',${JSON.stringify(metadata)}::jsonb,${encryptCredentials({ workerToken: token })}) ON CONFLICT (workspace_id,provider) DO UPDATE SET status='pairing',metadata=EXCLUDED.metadata,credentials=EXCLUDED.credentials,updated_at=now()`;
    return NextResponse.json({ token, appUrl: new URL(request.url).origin, expiresAt: metadata.pairExpiresAt });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not begin WhatsApp pairing." }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const rows = await database()`SELECT status,metadata,credentials FROM tl_connections WHERE workspace_id=${user.workspace_id} AND provider='whatsapp' LIMIT 1`;
    const connection = rows[0];
    if (!connection) return NextResponse.json({ status: "not_connected", qrDataUrl: null, token: null });
    const metadata = connection.metadata || {};
    const credentials = decryptCredentials(connection.credentials) || {};
    return NextResponse.json({ status: connection.status, qrDataUrl: metadata.qrDataUrl || null, token: connection.status === "pairing" ? credentials.workerToken || null : null });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load WhatsApp pairing." }, { status: 500 });
  }
}

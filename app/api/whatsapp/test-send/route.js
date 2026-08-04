import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const { phone, message, confirmed } = await request.json();
    const normalized = String(phone || "").replace(/[^0-9]/g, "");
    const body = String(message || "").trim();
    if (!confirmed) return NextResponse.json({ error: "Confirm that you have permission to message this number." }, { status: 400 });
    if (normalized.length < 8 || normalized.length > 15) return NextResponse.json({ error: "Use a full phone number including country code." }, { status: 400 });
    if (!body || body.length > 1500) return NextResponse.json({ error: "Enter a message up to 1,500 characters." }, { status: 400 });
    await ensureSchema(); const q = database();
    const connection = (await q`SELECT status FROM tl_connections WHERE workspace_id=${user.workspace_id} AND provider='whatsapp' LIMIT 1`)[0];
    if (connection?.status !== "connected") return NextResponse.json({ error: "Connect WhatsApp before sending a test." }, { status: 409 });
    const recent = (await q`SELECT count(*)::int AS count FROM tl_outbox WHERE workspace_id=${user.workspace_id} AND created_at > now() - interval '1 minute'`)[0];
    if (recent.count >= 3) return NextResponse.json({ error: "Test sending is limited to three messages per minute." }, { status: 429 });
    const id = `out_${randomBytes(12).toString("hex")}`;
    await q`INSERT INTO tl_outbox (id,workspace_id,phone,body) VALUES (${id},${user.workspace_id},${normalized},${body})`;
    return NextResponse.json({ ok: true, id });
  } catch (error) { return NextResponse.json({ error: error.message || "Could not queue test message." }, { status: 500 }); }
}

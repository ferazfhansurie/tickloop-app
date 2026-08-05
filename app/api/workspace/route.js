import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { database, ensureSchema } from "../../../lib/db";
export const runtime = "nodejs";
export async function GET(request) { try { const user = await currentUser(request); if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 }); await ensureSchema(); const q = database();
    // Self-heal: a connection holding credentials IS connected. Older builds
    // reset status to 'authorizing' whenever Connect was clicked again, which
    // stranded live shops in a permanent 'authorizing' state.
    await q`UPDATE tl_connections SET status='connected',updated_at=now() WHERE workspace_id=${user.workspace_id} AND status IN ('authorizing','pending') AND credentials IS NOT NULL`;
    const connections = await q`SELECT provider,status,external_id,metadata,updated_at FROM tl_connections WHERE workspace_id=${user.workspace_id} ORDER BY provider`; return NextResponse.json({ user, connections }); } catch (error) { return NextResponse.json({ error: error.message || "Could not load workspace." }, { status: 500 }); } }

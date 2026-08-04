import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function GET(request) { try { const user = await currentUser(request); return NextResponse.json({ user }); } catch { return NextResponse.json({ error: "The database is not connected yet." }, { status: 503 }); } }

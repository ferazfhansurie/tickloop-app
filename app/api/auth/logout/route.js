import { NextResponse } from "next/server";
import { COOKIE, deleteSession } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function POST(request) { await deleteSession(request); const response = NextResponse.json({ ok: true }); response.cookies.set(COOKIE, "", { path: "/", maxAge: 0 }); return response; }

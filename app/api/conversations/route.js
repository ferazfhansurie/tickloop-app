import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { database, ensureSchema } from "../../../lib/db";

export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const conversations = await database()`SELECT c.id,c.provider,c.external_id,c.customer_name,c.customer_phone,c.last_message_at,
      (SELECT body FROM tl_messages m WHERE m.conversation_id=c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
      (SELECT sent_at FROM tl_messages m WHERE m.conversation_id=c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message_at
      FROM tl_conversations c WHERE c.workspace_id=${user.workspace_id} ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT 100`;
    return NextResponse.json({ conversations });
  } catch (error) { return NextResponse.json({ error: error.message || "Could not load conversations." }, { status: 500 }); }
}

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const q = database(); const suffix = randomBytes(3).toString("hex").toUpperCase();
    const orderId = `TEST-${suffix}`; const conversationId = `cv_test_${randomBytes(10).toString("hex")}`;
    await q`INSERT INTO tl_orders (id,workspace_id,provider,external_id,customer_name,customer_phone,consented,status,total_cents,currency,is_test,payload) VALUES (${`ord_${randomBytes(12).toString("hex")}`},${user.workspace_id},'tiktok_shop',${orderId},'Test buyer','+60 11 1111 1111',true,'PAID',8900,'MYR',true,${JSON.stringify({ product: 'TickLoop sample order' })}::jsonb)`;
    await q`INSERT INTO tl_conversations (id,workspace_id,provider,external_id,customer_name,customer_phone,last_message_at) VALUES (${conversationId},${user.workspace_id},'tiktok_shop',${orderId},'Test buyer','+60 11 1111 1111',now())`;
    await q`INSERT INTO tl_messages (id,conversation_id,external_id,direction,body) VALUES (${`msg_${randomBytes(12).toString("hex")}`},${conversationId},${`test_${suffix}`},'system',${`Test TikTok Shop order ${orderId} created. No WhatsApp message was sent.`})`;
    return NextResponse.json({ ok: true, orderId });
  } catch (error) { return NextResponse.json({ error: error.message || "Could not create test order." }, { status: 500 }); }
}

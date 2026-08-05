const path = require("path");
const fs = require("fs");
const express = require("express");
const QRCode = require("qrcode");
const { create, ev } = require("@open-wa/wa-automate");

const localConfig = fs.existsSync(path.join(__dirname, ".tickloop-worker.json")) ? JSON.parse(fs.readFileSync(path.join(__dirname, ".tickloop-worker.json"), "utf8")) : {};
const appUrl = (process.env.TICKLOOP_URL || localConfig.appUrl || "").replace(/\/$/, "");
const token = process.env.TICKLOOP_WORKER_TOKEN || localConfig.workerToken;
if (!appUrl || !token) throw new Error("TickLoop worker configuration is missing.");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let qrImage = "", state = "Starting WhatsApp…", client, connectedPhone = null, outboxBusy = false;
const received = new Set();

async function report(body) {
  const response = await fetch(appUrl + "/api/whatsapp/worker", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("TickLoop rejected worker event (" + response.status + "): " + await response.text());
}

async function pullOutbox() {
  if (!client || !connectedPhone || outboxBusy) return;
  outboxBusy = true;
  try {
    const response = await fetch(appUrl + "/api/whatsapp/outbox", { headers: { authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Could not load TickLoop outbox.");
    const item = (await response.json()).item; if (!item) return;
    try {
      const externalId = await client.sendText(item.phone + "@c.us", item.body);
      await fetch(appUrl + "/api/whatsapp/outbox", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ id: item.id, status: "sent", externalId: typeof externalId === "string" ? externalId : null }) });
    } catch (error) {
      await fetch(appUrl + "/api/whatsapp/outbox", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ id: item.id, status: "failed", error: error.message || "WhatsApp could not send the message." }) });
    }
  } finally { outboxBusy = false; }
}

async function syncChats() {
  try {
    const chats = (await client.getAllChats()).filter(chat => !String(chat.id || "").endsWith("@g.us") && !String(chat.id || "").includes("status@broadcast")).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 100);
    let imported = 0; await report({ type: "sync_status", status: "syncing", imported, total: chats.length });
    for (const chat of chats) {
      try {
        const messages = await client.getAllMessagesInChat(chat.id, true, false);
        const avatarUrl = await client.getProfilePicFromServer(chat.id).catch(() => null);
        await report({ type: "sync", chat: { chatId: chat.id, name: chat.contact?.pushname || chat.contact?.name || chat.name || chat.contact?.formattedName || "WhatsApp contact", phone: String(chat.id).replace(/@.+$/, ""), avatarUrl, timestamp: chat.t || Math.floor(Date.now() / 1000), messages: messages.slice(-50).map(message => ({ id: message.id, body: message.body || "", timestamp: message.t, fromMe: message.fromMe })) } });
        imported += 1; if (imported % 5 === 0 || imported === chats.length) await report({ type: "sync_status", status: "syncing", imported, total: chats.length });
      } catch (error) { console.error("Could not import a WhatsApp chat:", error.message); }
    }
    state = "Connected to TickLoop."; await report({ type: "sync_status", status: "complete", imported, total: chats.length });
  } catch (error) {
    state = "Connected to TickLoop. Chat import could not start.";
    await report({ type: "sync_status", status: "retrying", error: error.message || "Could not read chat history." });
    console.error("Could not import WhatsApp history:", error);
  }
}

function captureIncoming(message) {
  if (!message || message.fromMe || String(message.from).endsWith("@g.us")) return;
  const id = message.id; if (!id || received.has(id)) return;
  received.add(id); if (received.size > 500) received.delete(received.values().next().value);
  report({ type: "message", messageId: id, chatId: message.from, body: message.body || "", timestamp: message.t, pushName: message.sender?.pushname || message.notifyName || null, phone: String(message.from).replace(/@.+$/, "") }).catch(error => console.error("Could not sync inbound message:", error.message));
}

ev.on("qrData.**", async rawQr => {
  if (typeof rawQr !== "string") return;
  qrImage = await QRCode.toDataURL(rawQr, { margin: 1, width: 320 });
  state = "Scan this QR code from WhatsApp → Linked devices.";
  report({ type: "qr", qrDataUrl: qrImage }).catch(error => console.error(error.message));
});

const app = express();
app.get("/", (_request, response) => response.type("html").send("<!doctype html><html><body><h1>TickLoop WhatsApp</h1><p>" + state + "</p>" + (qrImage ? "<img src='" + qrImage + "' alt='WhatsApp QR code'>" : "") + "</body></html>"));
app.listen(3333, "127.0.0.1", () => console.log("TickLoop OpenWA worker running on 127.0.0.1:3333."));

create({ sessionId: "tickloop-openwa", sessionDataPath: path.join(__dirname, ".openwa-sessions"), headless: true, useChrome: true, executablePath: fs.existsSync(chromePath) ? chromePath : undefined, qrTimeout: 0, authTimeout: 0, waitForRipeSessionTimeout: 0, qrLogSkip: true, disableSpins: true, cacheEnabled: false })
  .then(async openWaClient => {
    client = openWaClient; connectedPhone = await client.getHostNumber().catch(() => null);
    state = "Connected to TickLoop."; await report({ type: "status", status: "ready", phone: connectedPhone });
    await client.onMessage(captureIncoming); syncChats().catch(console.error);
  })
  .catch(error => { state = "OpenWA could not start."; console.error(error); });

setInterval(() => { if (connectedPhone) report({ type: "status", status: "ready", phone: connectedPhone }).catch(() => {}); }, 60000).unref();
setInterval(() => { pullOutbox().catch(error => console.error(error.message)); }, 10000).unref();

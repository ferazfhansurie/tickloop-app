const path = require("path");
const fs = require("fs");
const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const configPath = path.join(__dirname, ".tickloop-worker.json");
const localConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const appUrl = (process.env.TICKLOOP_URL || localConfig.appUrl || "").replace(/\/$/, "");
const token = process.env.TICKLOOP_WORKER_TOKEN || localConfig.workerToken;
if (!appUrl || !token) throw new Error("Set TICKLOOP_URL and TICKLOOP_WORKER_TOKEN using the command shown in TickLoop.");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePath = process.env.CHROME_PATH || (fs.existsSync(defaultChrome) ? defaultChrome : undefined);

let qrImage = "";
let state = "Starting WhatsApp Web…";
let syncAttempts = 0;
const app = express();
const port = Number(process.env.PORT || 3333);
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "tickloop", dataPath: path.join(__dirname, ".sessions") }),
  puppeteer: { headless: true, executablePath: chromePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] }
});

async function report(body) {
  const response = await fetch(`${appUrl}/api/whatsapp/worker`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`TickLoop rejected worker event (${response.status}): ${await response.text()}`);
}

async function pullOutbox() {
  if (!connectedPhone) return;
  const response = await fetch(`${appUrl}/api/whatsapp/outbox`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not load TickLoop outbox (${response.status}).`);
  const { item } = await response.json(); if (!item) return;
  try {
    const sent = await client.sendMessage(`${item.phone}@c.us`, item.body);
    await fetch(`${appUrl}/api/whatsapp/outbox`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ id: item.id, status: "sent", externalId: sent.id?._serialized || null }) });
  } catch (error) {
    await fetch(`${appUrl}/api/whatsapp/outbox`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ id: item.id, status: "failed", error: error.message || "WhatsApp could not send the message." }) });
  }
}

async function syncExistingChats() {
  try {
    const chats = (await client.getChats()).filter(chat => !chat.isGroup && !chat.id._serialized.includes("status@broadcast")).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 100);
    let imported = 0; await report({ type: "sync_status", status: "syncing", imported, total: chats.length });
    for (const chat of chats) {
      try {
        const contact = await chat.getContact();
        const avatarUrl = await client.getProfilePicUrl(chat.id._serialized).catch(() => null);
        const messages = await chat.fetchMessages({ limit: 50 });
        await report({ type: "sync", chat: { chatId: chat.id._serialized, name: contact.pushname || contact.name || chat.name || contact.number || "WhatsApp contact", phone: contact.number || chat.id.user || null, avatarUrl, timestamp: chat.timestamp || Math.floor(Date.now() / 1000), messages: messages.map(message => ({ id: message.id._serialized, body: message.body || "", timestamp: message.timestamp, fromMe: message.fromMe })) } });
        imported += 1; if (imported === chats.length || imported % 5 === 0) await report({ type: "sync_status", status: "syncing", imported, total: chats.length });
      } catch (error) { console.error("Could not sync a WhatsApp chat:", error.message); }
    }
    syncAttempts = 0; state = "Connected to TickLoop."; await report({ type: "sync_status", status: "complete", imported, total: chats.length });
  } catch (error) {
    syncAttempts += 1; state = "Connected to TickLoop. Retrying chat import…"; await report({ type: "sync_status", status: "retrying", error: error.message || "WhatsApp Web chat list is not ready." });
    if (syncAttempts <= 5) setTimeout(() => syncExistingChats().catch(console.error), 30000).unref();
    throw error;
  }
}

client.on("qr", async value => { qrImage = await QRCode.toDataURL(value, { margin: 1, width: 320 }); state = "Scan this QR code from WhatsApp → Linked devices."; report({ type: "qr", qrDataUrl: qrImage }).catch(console.error); });
client.on("authenticated", () => { state = "WhatsApp authenticated. Finishing setup…"; report({ type: "status", status: "authenticated" }).catch(console.error); });
let connectedPhone = null;
client.on("ready", async () => { const info = client.info || {}; connectedPhone = info.wid?.user || null; state = "Connected to TickLoop. Importing your latest chats…"; await report({ type: "status", status: "ready", phone: connectedPhone }); syncExistingChats().then(() => { state = "Connected to TickLoop."; }).catch(error => console.error(error)); });
client.on("auth_failure", message => { state = `Authentication failed: ${message}`; });
client.on("disconnected", reason => { state = `Disconnected: ${reason}`; report({ type: "status", status: "disconnected" }).catch(console.error); });
client.on("message", message => {
  if (message.fromMe || message.from.endsWith("@g.us")) return;
  report({ type: "message", messageId: message.id._serialized, chatId: message.from, body: message.body || "", timestamp: message.timestamp, pushName: message._data?.notifyName || null, phone: message.from.replace(/@.+$/, "") }).catch(console.error);
});

app.get("/", (_request, response) => response.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TickLoop WhatsApp</title><style>body{font-family:system-ui;background:#f5f8f5;color:#17221b;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #dce6de;border-radius:20px;padding:30px;max-width:390px;text-align:center}img{width:100%;max-width:320px}.muted{color:#6d7a72;font-size:14px}</style></head><body><main class="card"><h1>TickLoop WhatsApp</h1><p>${state}</p>${qrImage ? `<img src="${qrImage}" alt="WhatsApp QR code">` : ""}<p class="muted">This page stays on your laptop.</p></main><script>setTimeout(()=>location.reload(),2500)</script></body></html>`));
app.listen(port, "127.0.0.1", () => console.log(`Open http://127.0.0.1:${port} to scan the WhatsApp QR code.`));
setInterval(() => { if (connectedPhone) report({ type: "status", status: "ready", phone: connectedPhone }).catch(console.error); }, 60000).unref();
setInterval(() => { pullOutbox().catch(error => console.error(error.message)); }, 2000).unref();
client.initialize();

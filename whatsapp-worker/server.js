const path = require("path");
const fs = require("fs");
const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const appUrl = (process.env.TICKLOOP_URL || "").replace(/\/$/, "");
const token = process.env.TICKLOOP_WORKER_TOKEN;
if (!appUrl || !token) throw new Error("Set TICKLOOP_URL and TICKLOOP_WORKER_TOKEN using the command shown in TickLoop.");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePath = process.env.CHROME_PATH || (fs.existsSync(defaultChrome) ? defaultChrome : undefined);

let qrImage = "";
let state = "Starting WhatsApp Web…";
const app = express();
const port = Number(process.env.PORT || 3333);
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "tickloop", dataPath: path.join(__dirname, ".sessions") }),
  puppeteer: { headless: true, executablePath: chromePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] }
});

async function report(body) {
  const response = await fetch(`${appUrl}/api/whatsapp/worker`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`TickLoop rejected worker event (${response.status}).`);
}

client.on("qr", async value => { qrImage = await QRCode.toDataURL(value, { margin: 1, width: 320 }); state = "Scan this QR code from WhatsApp → Linked devices."; report({ type: "qr", qrDataUrl: qrImage }).catch(console.error); });
client.on("authenticated", () => { state = "WhatsApp authenticated. Finishing setup…"; report({ type: "status", status: "authenticated" }).catch(console.error); });
client.on("ready", async () => { const info = client.info || {}; state = "Connected to TickLoop."; await report({ type: "status", status: "ready", phone: info.wid?.user || null }); });
client.on("auth_failure", message => { state = `Authentication failed: ${message}`; });
client.on("disconnected", reason => { state = `Disconnected: ${reason}`; report({ type: "status", status: "disconnected" }).catch(console.error); });
client.on("message", message => {
  if (message.fromMe || message.from.endsWith("@g.us")) return;
  report({ type: "message", messageId: message.id._serialized, chatId: message.from, body: message.body || "", timestamp: message.timestamp, pushName: message._data?.notifyName || null, phone: message.from.replace(/@.+$/, "") }).catch(console.error);
});

app.get("/", (_request, response) => response.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TickLoop WhatsApp</title><style>body{font-family:system-ui;background:#f5f8f5;color:#17221b;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #dce6de;border-radius:20px;padding:30px;max-width:390px;text-align:center}img{width:100%;max-width:320px}.muted{color:#6d7a72;font-size:14px}</style></head><body><main class="card"><h1>TickLoop WhatsApp</h1><p>${state}</p>${qrImage ? `<img src="${qrImage}" alt="WhatsApp QR code">` : ""}<p class="muted">This page stays on your laptop.</p></main><script>setTimeout(()=>location.reload(),2500)</script></body></html>`));
app.listen(port, "127.0.0.1", () => console.log(`Open http://127.0.0.1:${port} to scan the WhatsApp QR code.`));
client.initialize();

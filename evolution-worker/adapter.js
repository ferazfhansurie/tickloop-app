const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");

function readEnv(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

const baseDir = __dirname;
const environment = readEnv(path.join(baseDir, ".env"));
const localConfig = {
  ...readJson(path.join(baseDir, ".tickloop-evolution.json")),
  ...readJson(path.join(baseDir, "..", "whatsapp-worker", ".tickloop-worker.json")),
};
const tickloopUrl = String(process.env.TICKLOOP_URL || localConfig.appUrl || "").replace(/\/$/, "");
const workerToken = process.env.TICKLOOP_WORKER_TOKEN || localConfig.workerToken;
const evolutionUrl = String(process.env.EVOLUTION_URL || "http://127.0.0.1:8081").replace(/\/$/, "");
const apiKey = process.env.EVO_API_KEY || environment.EVO_API_KEY || environment.AUTHENTICATION_API_KEY;
const webhookKey = process.env.EVOLUTION_WEBHOOK_KEY || environment.EVOLUTION_WEBHOOK_KEY;
if (!tickloopUrl || !workerToken || !apiKey || !webhookKey) throw new Error("TickLoop Evolution adapter is missing local configuration.");

const instanceName = "tickloop-" + crypto.createHash("sha256").update(workerToken).digest("hex").slice(0, 18);
let lastQr = "";
let ready = false;
let instanceCreated = false;
let outboxBusy = false;
let historyCount = 0;
const historyChats = new Set();
const seen = new Set();

async function evolution(endpoint, options = {}) {
  const response = await fetch(evolutionUrl + endpoint, {
    ...options,
    headers: { apikey: apiKey, "content-type": "application/json", ...(options.headers || {}) },
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(typeof data === "object" ? JSON.stringify(data) : raw || `Evolution returned ${response.status}`);
  return data;
}

async function report(body) {
  const response = await fetch(tickloopUrl + "/api/whatsapp/worker", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + workerToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`TickLoop rejected worker event (${response.status}).`);
}

function asQr(value) {
  if (typeof value !== "string" || !value) return null;
  return value.startsWith("data:image/") ? value : value.startsWith("iVBOR") ? "data:image/png;base64," + value : null;
}

function qrFrom(payload) {
  const data = payload?.data || payload || {};
  return asQr(data.base64) || asQr(data.qrcode?.base64) || asQr(data.qrCode?.base64) || asQr(data.qrcode) || asQr(data.qr);
}

function textFrom(message = {}) {
  const candidates = [
    message.conversation,
    message.extendedTextMessage?.text,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
    message.buttonsResponseMessage?.selectedDisplayText,
    message.listResponseMessage?.title,
    message.templateButtonReplyMessage?.selectedDisplayText,
  ];
  const text = candidates.find(value => typeof value === "string" && value.trim());
  if (text) return text.trim();
  if (message.imageMessage) return "[Image]";
  if (message.videoMessage) return "[Video]";
  if (message.documentMessage) return "[Document]";
  if (message.audioMessage) return "[Audio]";
  return "";
}

function normaliseMessage(entry) {
  const key = entry?.key || entry?.message?.key || {};
  const message = entry?.message || entry?.data?.message || {};
  const chatId = key.remoteJid || entry?.remoteJid || entry?.chatId;
  const messageId = key.id || entry?.id || entry?.messageId;
  if (!chatId || !messageId || String(chatId).endsWith("@g.us") || String(chatId).includes("status@broadcast")) return null;
  return {
    messageId: String(messageId),
    chatId: String(chatId),
    body: textFrom(message),
    timestamp: Number(entry?.messageTimestamp || entry?.message?.messageTimestamp || entry?.timestamp || Math.floor(Date.now() / 1000)),
    pushName: entry?.pushName || entry?.pushname || entry?.senderName || null,
    phone: String(chatId).replace(/@.+$/, ""),
    fromMe: Boolean(key.fromMe || entry?.fromMe),
    avatarUrl: entry?.profilePicUrl || entry?.profilePictureUrl || null,
  };
}

async function forwardMessage(item, history = false) {
  if (!item || seen.has(item.messageId)) return;
  seen.add(item.messageId);
  if (seen.size > 3000) seen.delete(seen.values().next().value);
  if (history) {
    if (!historyChats.has(item.chatId) && historyChats.size >= 100) return;
    historyChats.add(item.chatId);
    await report({ type: "sync", chat: { chatId: item.chatId, name: item.pushName || "WhatsApp contact", phone: item.phone, avatarUrl: item.avatarUrl, timestamp: item.timestamp, messages: [{ id: item.messageId, body: item.body, timestamp: item.timestamp, fromMe: item.fromMe }] } });
    historyCount += 1;
  } else if (!item.fromMe) {
    await report({ type: "message", messageId: item.messageId, chatId: item.chatId, body: item.body, timestamp: item.timestamp, pushName: item.pushName, phone: item.phone });
  }
}

async function reportQr(payload) {
  const qr = qrFrom(payload);
  if (qr && qr !== lastQr) {
    await report({ type: "qr", qrDataUrl: qr });
    lastQr = qr;
  }
}

async function ensureInstance() {
  const instances = await evolution("/instance/fetchInstances", { method: "GET" });
  const found = Array.isArray(instances) && instances.find(item => (item.instance?.instanceName || item.name || item.instanceName) === instanceName);
  if (!found) {
    const created = await evolution("/instance/create", { method: "POST", body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true }) });
    instanceCreated = true;
    await reportQr(created);
  } else instanceCreated = true;
  await evolution(`/settings/set/${instanceName}`, { method: "POST", body: JSON.stringify({ rejectCall: false, msgCall: "", groupsIgnore: false, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: true }) });
}

async function refreshState() {
  await ensureInstance();
  const state = await evolution(`/instance/connectionState/${instanceName}`, { method: "GET" });
  const connection = state?.instance?.state || state?.state || state?.instance?.connectionStatus || "";
  if (String(connection).toLowerCase() === "open") {
    if (!ready) await report({ type: "status", status: "ready", phone: state?.instance?.ownerJid || state?.instance?.wuid || null });
    ready = true;
    await report({ type: "sync_status", status: "syncing", imported: historyCount, total: 100 });
    return;
  }
  ready = false;
  const qr = await evolution(`/instance/connect/${instanceName}`, { method: "GET" }).catch(() => null);
  await reportQr(qr);
}

async function pullOutbox() {
  if (!ready || outboxBusy) return;
  outboxBusy = true;
  try {
    const response = await fetch(tickloopUrl + "/api/whatsapp/outbox", { headers: { authorization: "Bearer " + workerToken } });
    if (!response.ok) throw new Error("Could not load TickLoop outbox.");
    const item = (await response.json()).item;
    if (!item) return;
    try {
      const result = await evolution(`/message/sendText/${instanceName}`, { method: "POST", body: JSON.stringify({ number: item.phone, text: item.body }) });
      const externalId = result?.key?.id || result?.message?.key?.id || result?.id || null;
      await fetch(tickloopUrl + "/api/whatsapp/outbox", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + workerToken }, body: JSON.stringify({ id: item.id, status: "sent", externalId }) });
    } catch (error) {
      await fetch(tickloopUrl + "/api/whatsapp/outbox", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + workerToken }, body: JSON.stringify({ id: item.id, status: "failed", error: error.message || "Evolution could not send the message." }) });
    }
  } finally { outboxBusy = false; }
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/", (_request, response) => response.json({ service: "TickLoop Evolution adapter", instanceName, ready, instanceCreated }));
app.post("/evolution/webhook", (request, response) => {
  if (request.query.key !== webhookKey) return response.status(401).json({ error: "Invalid webhook key." });
  const event = String(request.body?.event || "").toLowerCase();
  const data = request.body?.data || request.body;
  if (event.includes("qrcode")) reportQr(data).catch(error => console.error("QR forwarding failed:", error.message));
  if (event.includes("connection")) {
    const state = String(data?.state || data?.connection || "").toLowerCase();
    if (state === "open") { ready = true; report({ type: "status", status: "ready", phone: data?.wuid || data?.ownerJid || null }).catch(error => console.error(error.message)); }
    if (["close", "closed"].includes(state)) { ready = false; report({ type: "status", status: "disconnected" }).catch(error => console.error(error.message)); }
  }
  if (event.includes("messages.set")) {
    const rows = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
    Promise.all(rows.map(row => forwardMessage(normaliseMessage(row), true))).then(async () => {
      if (data?.isLatest) await report({ type: "sync_status", status: "complete", imported: historyCount, total: historyCount });
    }).catch(error => console.error("History forwarding failed:", error.message));
  }
  if (event.includes("messages.upsert")) {
    const rows = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [data];
    Promise.all(rows.map(row => forwardMessage(normaliseMessage(row), false))).catch(error => console.error("Message forwarding failed:", error.message));
  }
  response.json({ ok: true });
});

app.listen(3333, "0.0.0.0", () => {
  console.log(`TickLoop Evolution adapter listening on 3333 for ${instanceName}.`);
  refreshState().catch(error => console.error("Evolution startup failed:", error.message));
});

setInterval(() => refreshState().catch(error => console.error("Evolution state refresh failed:", error.message)), 10000).unref();
setInterval(() => pullOutbox().catch(error => console.error("Outbox pull failed:", error.message)), 3000).unref();

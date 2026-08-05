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

// Evolution keeps the full WhatsApp history in its own store, but the
// messages.set webhook only ever hands us a small recent slice per chat (~15).
// So once the instance is live we pull the rest over Evolution's REST API.
const HISTORY_CHAT_LIMIT = Number(process.env.TICKLOOP_HISTORY_CHATS || 250);
const HISTORY_MESSAGE_LIMIT = Number(process.env.TICKLOOP_HISTORY_MESSAGES || 500);
const HISTORY_CHUNK = 150; // messages per report call — keeps each insert batch quick
// Attachments are shipped one per call (base64 is bulky), so cap how many we
// capture per chat during the historical sweep. Live media is always captured.
const MEDIA_PER_CHAT = Number(process.env.TICKLOOP_HISTORY_MEDIA || 40);
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
let backfillRunning = false;
let backfillDone = false;

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

// Which attachment kind (if any) a raw Evolution record represents.
function mediaKindOf(entry) {
  const message = entry?.message || entry?.data?.message || {};
  const type = String(entry?.messageType || "");
  if (type === "imageMessage" || message.imageMessage) return "image";
  if (type === "videoMessage" || message.videoMessage) return "video";
  if (type === "audioMessage" || message.audioMessage) return "audio";
  if (type === "stickerMessage" || message.stickerMessage) return "sticker";
  if (type === "documentMessage" || message.documentMessage || message.documentWithCaptionMessage) return "document";
  return null;
}

// Evolution decrypts WhatsApp media locally and hands it back as base64. Only the
// laptop can do this (the media keys live in the Baileys session), which is why
// capture happens here and the bytes are shipped to TickLoop rather than linked.
async function fetchMedia(key, kind) {
  try {
    const result = await evolution(`/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: "POST",
      body: JSON.stringify({ message: { key } }),
    });
    if (!result?.base64) return null;
    const size = Number(result.size?.fileLength || result.size) || Math.round((result.base64.length * 3) / 4);
    if (size > MEDIA_MAX_BYTES) return null;
    return { base64: result.base64, mime: result.mimetype || "application/octet-stream", name: result.fileName || null, size, kind };
  } catch {
    return null;
  }
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
    // A WhatsApp "@lid" is a hidden-identity handle, NOT a phone number — storing
    // its digits made the inbox show things like "28347136504059" as the contact's
    // number. Only real @s.whatsapp.net JIDs carry a dialable number.
    phone: String(chatId).endsWith("@lid") ? null : String(chatId).replace(/@.+$/, ""),
    fromMe: Boolean(key.fromMe || entry?.fromMe),
    avatarUrl: entry?.profilePicUrl || entry?.profilePictureUrl || null,
    raw: entry,
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
    // Capture attachments on arrival so the inbox shows the actual photo/file
    // rather than an "[Image]" placeholder.
    const kind = mediaKindOf(item.raw);
    const media = kind ? await fetchMedia(item.raw?.key || { id: item.messageId, remoteJid: item.chatId }, kind) : null;
    await report({ type: "message", messageId: item.messageId, chatId: item.chatId, body: item.body, timestamp: item.timestamp, pushName: item.pushName, phone: item.phone, media });
  }
}

// Pull each chat's stored history out of Evolution and push it into TickLoop.
// Runs once per process after the instance reports "open".
async function backfillHistory() {
  if (backfillRunning || backfillDone || !ready) return;
  backfillRunning = true;
  let imported = 0;
  let available = 0;
  try {
    const chats = await evolution(`/chat/findChats/${instanceName}`, { method: "POST", body: "{}" });
    const list = (Array.isArray(chats) ? chats : chats?.records || chats?.chats || [])
      .filter(chat => {
        const jid = String(chat.remoteJid || chat.id || "");
        return jid && !jid.endsWith("@g.us") && !jid.includes("status@broadcast");
      })
      .slice(0, HISTORY_CHAT_LIMIT);
    await report({ type: "sync_status", status: "syncing", imported: 0, total: 0 });

    for (const chat of list) {
      const jid = String(chat.remoteJid || chat.id);
      const payload = await evolution(`/chat/findMessages/${instanceName}`, {
        method: "POST",
        body: JSON.stringify({ where: { key: { remoteJid: jid } }, page: 1, offset: HISTORY_MESSAGE_LIMIT }),
      }).catch(() => null);
      const records = payload?.messages?.records || payload?.records || (Array.isArray(payload) ? payload : []);
      available += Number(payload?.messages?.total) || records.length;

      const messages = records
        .map(normaliseMessage)
        .filter(item => item && item.body)
        .map(item => ({ id: item.messageId, body: item.body, timestamp: item.timestamp, fromMe: item.fromMe }));
      if (!messages.length) continue;
      messages.sort((a, b) => a.timestamp - b.timestamp);

      // Chunked so a 2,000-message thread doesn't become one giant insert loop.
      for (let index = 0; index < messages.length; index += HISTORY_CHUNK) {
        const slice = messages.slice(index, index + HISTORY_CHUNK);
        await report({
          type: "sync",
          chat: {
            chatId: jid,
            name: chat.pushName || "WhatsApp contact",
            phone: jid.endsWith("@lid") ? null : jid.replace(/@.+$/, ""),
            avatarUrl: chat.profilePicUrl || null,
            timestamp: slice[slice.length - 1].timestamp,
            messages: slice,
          },
        });
        imported += slice.length;
      }
      // Second pass: attach real attachments to the newest media messages. These
      // go one per call because base64 payloads are large; the server upserts them
      // onto the rows the text pass just created.
      const mediaRecords = records
        .filter(record => mediaKindOf(record))
        .sort((a, b) => Number(b.messageTimestamp || 0) - Number(a.messageTimestamp || 0))
        .slice(0, MEDIA_PER_CHAT);
      for (const record of mediaRecords) {
        const item = normaliseMessage(record);
        if (!item) continue;
        const media = await fetchMedia(record.key, mediaKindOf(record));
        if (!media) continue;
        await report({
          type: "sync",
          chat: {
            chatId: jid,
            name: chat.pushName || "WhatsApp contact",
            phone: jid.endsWith("@lid") ? null : jid.replace(/@.+$/, ""),
            avatarUrl: chat.profilePicUrl || null,
            timestamp: item.timestamp,
            messages: [{ id: item.messageId, body: item.body, timestamp: item.timestamp, fromMe: item.fromMe, media }],
          },
        }).catch(() => {});
      }

      historyChats.add(jid);
      historyCount = imported;
      await report({ type: "sync_status", status: "syncing", imported, total: available }).catch(() => {});
    }

    backfillDone = true;
    // Same person can land twice (an @lid handle plus a phone JID); fold them together.
    const dedupe = await fetch(tickloopUrl + "/api/whatsapp/worker", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + workerToken },
      body: JSON.stringify({ type: "merge_duplicates" }),
    }).then(response => response.json()).catch(() => null);
    if (dedupe?.merged) console.log(`Merged ${dedupe.merged} duplicate conversation(s).`);
    await report({ type: "sync_status", status: "complete", imported, total: available });
    console.log(`History backfill complete: ${imported} messages from ${list.length} chats.`);
  } catch (error) {
    console.error("History backfill failed:", error.message);
    await report({ type: "sync_status", status: "retrying", imported, total: available, error: error.message }).catch(() => {});
  } finally {
    backfillRunning = false;
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
    // The backfill owns sync_status once it starts; don't clobber its progress.
    if (!backfillDone && !backfillRunning) backfillHistory().catch(error => console.error("Backfill error:", error.message));
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
      // Prefer the full JID: @lid contacts have no dialable number at all.
      const number = item.recipient || item.phone;
      const result = item.media_base64
        ? await evolution(`/message/sendMedia/${instanceName}`, {
            method: "POST",
            body: JSON.stringify({
              number,
              // Evolution's sendMedia takes image | video | audio | document.
              mediatype: item.media_kind === "sticker" ? "image" : (item.media_kind || "document"),
              mimetype: item.media_mime || "application/octet-stream",
              media: item.media_base64,
              fileName: item.media_name || "file",
              caption: item.body || "",
            }),
          })
        : await evolution(`/message/sendText/${instanceName}`, { method: "POST", body: JSON.stringify({ number, text: item.body }) });
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

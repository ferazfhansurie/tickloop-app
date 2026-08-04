"use client";

import { useEffect, useState } from "react";

export default function WhatsAppConnectPage() {
  const [pairing, setPairing] = useState({ loading: true, token: "", appUrl: "", error: "" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch("/api/whatsapp/pair", { method: "POST" }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not start pairing.");
      setPairing({ loading: false, token: payload.token, appUrl: payload.appUrl, error: "" });
    }).catch(error => setPairing({ loading: false, token: "", appUrl: "", error: error.message }));
  }, []);
  const command = pairing.token ? `cd whatsapp-worker && PUPPETEER_SKIP_DOWNLOAD=true npm install && TICKLOOP_URL=${pairing.appUrl} TICKLOOP_WORKER_TOKEN=${pairing.token} npm start` : "";
  async function copy() { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1800); }
  return <main className="pairShell"><section className="pairCard"><a href="/" className="backLink">← Back to inbox</a><p className="eyebrow">LOCAL WHATSAPP WORKER</p><h1>Connect from your laptop.</h1><p>TickLoop will keep the WhatsApp session on this laptop. Run the worker, then scan the QR code at <b>http://127.0.0.1:3333</b> using WhatsApp on your phone.</p>{pairing.loading && <p className="pairStatus">Creating a secure pairing token…</p>}{pairing.error && <p className="error">{pairing.error}</p>}{pairing.token && <><ol><li>Open Terminal in the TickLoop project folder.</li><li>Run this once. The token expires in 15 minutes.</li><li>Open the local QR page and scan it from WhatsApp → Linked devices.</li></ol><pre>{command}</pre><button className="primary wide" onClick={copy}>{copied ? "Copied" : "Copy setup command"}</button><p className="pairNote">Keep the worker terminal open. Its WhatsApp session is stored only on this laptop.</p></>}</section></main>;
}

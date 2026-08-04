# TickLoop WhatsApp worker

This worker runs on the laptop that owns the WhatsApp account. It keeps the WhatsApp Web session in `.sessions/`, which must stay private and must not be committed or uploaded.

Use the pairing command shown at `/connect/whatsapp` while signed in to TickLoop. Then open `http://127.0.0.1:3333` and scan the QR code from WhatsApp → Linked devices.

On macOS, the worker automatically uses Google Chrome. On another platform, set `CHROME_PATH` to the browser executable before running it.

This uses `whatsapp-web.js`, an unofficial WhatsApp Web client. WhatsApp may restrict unsupported automation; use it only with a number you control and for consented customer support.

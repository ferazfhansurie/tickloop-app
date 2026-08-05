# TickLoop Evolution adapter

This local adapter keeps Evolution API private on the laptop and forwards only workspace-scoped WhatsApp data to TickLoop. Start it through the bundled LaunchAgent after Docker Desktop is running.

The Evolution dashboard/API is bound to `127.0.0.1:8081` and must not be exposed publicly.

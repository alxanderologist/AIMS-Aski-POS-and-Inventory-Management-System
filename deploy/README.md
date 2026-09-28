# Deployment scripts

Supporting files for the plan in `../deployment.md` (read that first — this folder just holds the
scripts/config it references). **Start with `INSTALL.md`** if you're doing a real install.

- `INSTALL.md` — Phase 4: the actual step-by-step install runbook for a fresh store server.
- `install-services.ps1` — Phase 4: installs the backend and AI service as Windows Services (NSSM),
  auto-starting on boot and restarting on crash. Run as Administrator; see `INSTALL.md` step 9.
- `cashier-kiosk.bat` — Phase 1: run at login on the cashier PC to open the POS fullscreen with no
  browser chrome, pointed at the store server. Edit `POS_URL` inside it once the server's LAN
  address is known, then drop it (or a shortcut to it) into `shell:startup`.

# Install runbook — store server (Windows 10)

Follow this top to bottom for a fresh install on the store server PC. `deployment.md` is the audit
and the reasoning behind each step; this is the actual checklist. Do the risk check in
`deployment.md`'s "Risks to test first" (printer sharing) before or alongside this if the TM-T82X
hasn't been wired up yet — see `print.md`.

## 1. Prerequisites (server PC)

Install these first, in any order:

- **Node.js** (LTS) — https://nodejs.org
- **PostgreSQL** (matching what's used in development; this project has been run against
  PostgreSQL 18) — https://www.postgresql.org/download/windows/. Remember the `postgres` user's
  password set during install.
- **Python 3.12+** — https://www.python.org/downloads/windows/ (check "Add python.exe to PATH"
  during install)
- **Git** — https://git-scm.com/download/win
- **NSSM** — https://nssm.cc/download. Extract `nssm.exe` (the `win64` build) into a folder that's
  on `PATH` (e.g. `C:\Windows\System32`, or add its folder to the system `PATH`).

## 2. Get the code

```
git clone <this repo's URL> C:\aims-pos-inventory
cd C:\aims-pos-inventory
```

(Or copy the repo another way — just land it somewhere stable; the rest of this guide assumes
`C:\aims-pos-inventory`.)

## 3. Database

1. Open a Command Prompt and create the database:
   ```
   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE \"aims-pos-ims-db\";"
   ```
2. Copy `backend\.env.example` to `backend\.env` and fill in real values — at minimum:
   - `DATABASE_URL` — the real password from step 1.
   - `JWT_SECRET` — generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `NODE_ENV=production`
   - `FRONTEND_URL` — the server's LAN address, once known (e.g. `http://192.168.1.50:5000`) —
     see the "Server address" open item in `deployment.md`.
   - `AI_SERVICE_KEY` — required because `NODE_ENV=production` — generate the same way as
     `JWT_SECRET` and copy the same value into `ai-service\.env`.
   - `BACKUP_EXTERNAL_DIR`, `BACKUP_CLOUD_DIR` — see step 8.
   - The store identity and POS accreditation block at the bottom (`STORE_*`, `POS_*`) — these carry
     real BIR compliance weight; do not leave the placeholders in place.
3. From `backend\`, build the schema from the migration history (not `db push` — this is what makes
   the install reproducible, see `deployment.md` Phase 0):
   ```
   cd C:\aims-pos-inventory\backend
   npm install
   npx prisma migrate deploy
   ```
4. Create the first real admin (replaces the seeded demo `admin/admin123` — never run
   `npm run seed` against this database):
   ```
   node scripts\createFirstAdmin.js --username=admin --fullName="Store Admin"
   ```
   **Copy down the printed password immediately — it is shown once.**
5. If there's existing real data to bring over (an exported dump from another machine), restore it
   now instead of starting from empty, then skip step 4 (the admin already exists in that dump).
   Test any dump with `node scripts\restoreBackupTest.js <path-to-dump>` first if unsure it's good.

## 4. Backend

Already `npm install`ed in step 3. Nothing else needed here — it's launched as a service in step 9.

## 5. Frontend

```
cd C:\aims-pos-inventory\frontend
npm install
npm run build
```

This produces `frontend\dist\`, which the backend serves directly once it's running (no separate
web server needed — see `deployment.md` Phase 4).

## 6. AI service

```
cd C:\aims-pos-inventory\ai-service
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Copy `ai-service\.env.example` to `ai-service\.env` and set `AI_SERVICE_KEY` to the same value used
in `backend\.env`, and `NODE_ENV=production`.

## 7. Printer

Follow `print.md`'s "Printing from a separate server PC over the LAN" section (assuming the printer
is plugged into the cashier PC, per `deployment.md`'s decided architecture) — set
`RECEIPT_PRINTER_INTERFACE` in `backend\.env` once that's confirmed working.

## 8. Backups

1. Decide the external drive path and the cloud-sync folder path (see `deployment.md`'s open
   items), set `BACKUP_EXTERNAL_DIR` / `BACKUP_CLOUD_DIR` in `backend\.env` to them.
2. If `pg_dump`/`pg_restore`/`psql` aren't on `PATH`, set `PG_BIN_DIR` in `backend\.env` to the
   Postgres `bin` folder (e.g. `C:\Program Files\PostgreSQL\18\bin`).
3. After the backend service is running (step 9), let one nightly backup happen (or trigger one
   manually — see `backend\services\backup.js`'s `runBackup()`), then prove it restores:
   ```
   cd C:\aims-pos-inventory\backend
   node scripts\restoreBackupTest.js
   ```

## 9. Install as Windows services

From an **Administrator** PowerShell:

```powershell
cd C:\aims-pos-inventory
.\deploy\install-services.ps1
nssm start AimsAiService
nssm start AimsBackend
```

Confirm both are running: `Get-Service Aims*`, or open `services.msc`. Then check
`http://localhost:5000/api/health` returns `{"status":"ok",...}` and `http://localhost:5000/`
loads the login page.

## 10. Windows Firewall

Restrict the backend and AI service to the store LAN (adjust the LAN subnet to match the store's
actual network):

```powershell
New-NetFirewallRule -DisplayName "AIMS Backend (LAN only)" -Direction Inbound -Protocol TCP -LocalPort 5000 -RemoteAddress 192.168.1.0/24 -Action Allow
```

The AI service (port 8000) doesn't need a rule at all if it's bound to `127.0.0.1` as configured in
step 9 — it's already unreachable from the network.

## 11. Cashier PC(s)

On each cashier PC:

1. Confirm it can reach `http://<server-LAN-address>:5000` in a browser.
2. Edit `deploy\cashier-kiosk.bat` (copy it to the cashier PC, or share it over the network) —
   set `POS_URL` to the real server address.
3. Copy it into `shell:startup` (Win+R → `shell:startup` → Enter → paste the file there).
4. Set up printer sharing per `print.md` if the printer is on this PC.

## 12. Remote access (owner/admin)

Set up Cloudflare Tunnel + Cloudflare Access on the server, pointed at `localhost:5000` — needs the
domain name from `deployment.md`'s open items. Not covered step-by-step here yet (revisit once the
domain is chosen).

## 13. Go-live rehearsal

Before real use, do the full rehearsal in `deployment.md` Phase 5: a checkout, X-Reading, Z-Reading,
and void slip print across the LAN; unplug the network to confirm the offline behavior; confirm the
rollback plan (restore the pre-cutover backup) actually works.

## Updating later

1. Back up first: let the nightly backup run, or trigger one manually.
2. `git pull` (or copy the new code over).
3. `cd backend && npm install && npx prisma migrate deploy`
4. `cd frontend && npm install && npm run build`
5. `cd ai-service && venv\Scripts\activate && pip install -r requirements.txt`
6. `nssm restart AimsBackend` and `nssm restart AimsAiService`
7. Recheck `/api/health` and log in once to confirm.

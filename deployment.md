# Deployment Readiness Plan

This document captures the findings of a production-deployment audit of the AIMS POS & Inventory
Management System (backend/ — Express 5 + Socket.IO + Prisma/Postgres; frontend/ — React 19 +
Vite SPA; ai-service/ — FastAPI forecasting microservice) and the phased plan to close the gaps
before this system goes live.

Audit date: findings below were verified directly against the code, not assumed from older docs.
In particular, `backend/CLAUDE.md`'s note that "most endpoints are not currently JWT-protected" is
**stale** — every route in `backend/index.js` was checked directly and auth coverage is actually
solid (see Phase 1 Findings below). Don't let that old doc line drive this plan.

Each phase below follows the project's standing process: design questions get asked and answered
*before* any code is written for that phase, then the phase is implemented, tested against the
real system, and reported back — nothing here is implemented yet.

---

## Deployment target and final plan (decided 2026-09-25, updated 2026-09-28)

The audit below was written before the target environment was known. These decisions override its
order. The findings themselves are still valid.

### Constraints and decisions

- **All PCs are Windows 10** (per `deployment-architecture.txt`) — there is no Windows 7 cashier PC
  anymore. This retires the browser-compatibility risk that used to gate the plan (the last
  Windows 7 Chrome is 109, short of Tailwind v4's Chrome 111+ baseline); Windows 10 runs a current
  Edge/Chrome, so no fallback browser or Vite-target workaround is needed. Cashier PC(s) run only a
  browser (thin client).
- **A separate store server PC** runs Postgres, the backend, the AI service and the built frontend
  on the store LAN. Postgres and the AI service are bound to the server only (127.0.0.1 / LAN),
  never internet-facing.
- **Store LAN only for selling.** Selling must never depend on the internet.
- **Remote owner/admin access via Cloudflare Tunnel**, protected by a Cloudflare Access login. No
  router ports opened. A cloud copy of the database is deliberately not planned: it would need
  two-way sync. Revisit only if remote access is needed while the store PC is off.
- **The printer stays on the cashier PC**, shared over Windows networking; the server prints to it
  remotely. This needs the `winRawPrintDriver.js` remote-share code change (today it only sends to
  `\\localhost\<share>`) so it accepts a host name, e.g.
  `RECEIPT_PRINTER_INTERFACE=printer:\\CASHIER-PC\TM-T82X`. Accepted tradeoff: receipts don't print
  while that PC is off. (Scoped to one shared printer for now — a second cashier PC with its own
  printer would need per-terminal config later.)
- **Packaging:** plain Windows install with auto-start services (pm2 or NSSM), not Docker.
- **Data:** keep the current database (real products, stock and imported sales).
- **Backups:** nightly `pg_dump`, 14 days kept, copied to *both* an external drive on-site and a
  cloud folder off-site.

### Architecture

    CASHIER PC(s) (Windows 10)                     OWNER / ADMIN (remote)
    - browser only                                 - browser on phone or laptop
    - opens http://SERVER:5000                     - opens https://your-address
    - USB thermal printer (TM-T82X), shared                    |
           |                                                   | Cloudflare Tunnel +
           | store LAN                                         | Cloudflare Access login
           v                                                   v
    +----------------------------------------------------------------+
    |                  STORE SERVER PC (Windows 10)                  |
    |  Frontend (built)  --served by-->  Backend (Node, port 5000)   |
    |  PostgreSQL (5432, this PC only)                                |
    |  AI service (Python, 8000, this PC only)                       |
    |  Nightly backup --> external drive + cloud folder                |
    +----------------------------------------------------------------+
           |
           | receipts / X-Reading / Z-Reading / void slips
           v
    \\CASHIER-PC\TM-T82X  (Windows printer share)

### Risks to test first (before writing deployment code)

1. **Epson driver + printer sharing on Windows 10.** Confirm the TM-T82X driver installs, the
   printer shares correctly, and the server can reach it (`net view`, then a `copy /b` test, as in
   print.md) before building the remote-print code change.

### Phase order (final)

1. **Phase 0, data safety:** migration baseline, nightly `pg_dump` (14 days, external drive + cloud
   folder) with a tested restore, seeder and one-off script lockdown, first-admin script, replace
   demo passwords and supervisor PIN 1234.
2. **Phase 1, topology, config & terminal setup:** `VITE_API_BASE_URL`, `FRONTEND_URL` for CORS,
   backend serves the built frontend, startup env validation, AI service bound to 127.0.0.1, fixed
   LAN IP or name for the server — plus a kiosk-style shortcut on the cashier PC(s) that opens the
   POS at boot, printer sharing setup, the `winRawPrintDriver.js` remote-share code change, and a
   section in print.md.
3. **Phase 2, security:** helmet, IP rate limiting, remove the login-page credential hint, audit
   fixes, Windows Firewall rule limiting access to the store LAN, Cloudflare Access login in front
   of the tunnel.
4. **Phase 3, reliability:** `/api/health`, boot DB check, crash handlers, file logs with
   rotation, auto-start services with restart on crash, AI service without `--reload`.
5. **Phase 4, install and CI:** install runbook and script, update procedure (backup, pull,
   `migrate deploy`, build, restart), GitHub Actions, auth and checkout tests.
6. **Phase 5, go-live rehearsal:** clean-machine install with a copy of the real database; print a
   receipt, X-Reading, Z-Reading and void slip on the TM-T82X across the LAN; unplug the network
   to confirm the counter behaviour; rollback plan and cutover day.

### Open items

- Domain name for the Cloudflare Tunnel (needed before Phase 2's tunnel setup, ~$10/yr).
- Cloud folder provider for the off-site backup copy (Google Drive, Dropbox, OneDrive, etc.) and
  the account to use for it.

Note: everything below still applies, but read the Phase 0-4 sections in the order above.

---

## Severity key

- **Blocker** — deploying without fixing this will break the app, expose it to unauthenticated
  access, or risk irreversible data loss.
- **High** — should be fixed before real users/transactions touch the system.
- **Medium/Low** — worth doing, not launch-blocking on their own.

---

## Phase 0 — Data safety net — DONE (2026-09-28)

The one phase where a mistake is irreversible (lost or corrupted production data), so it came
first regardless of hosting choices made later. All five plan items below are implemented and
verified live against the real dev database (not just dry-run/unit tested).

### Findings (as originally audited — kept for record)

- **[Blocker] No versioned database migrations.** Only one migration existed:
  `backend/prisma/migrations/20260731111635_init/migration.sql`, dated 2026-07-31. Every schema
  change since (Balik Tangkilik membership/points, StockBatch/FIFO costing, ForecastSnapshot,
  reconciliation support, etc. — 16 commits touching `schema.prisma`) went through
  `prisma db push` only. Running `prisma migrate deploy` against a fresh production database would
  **not** have produced the current schema.
- **[Blocker] The only DB bootstrap script was destructive and insecure.** `backend/seeder.js`
  (wired as the official `npm run seed` / `prisma db seed` command) unconditionally wipes nearly
  every core table, then recreates 5 login accounts with trivially guessable passwords
  (`admin/admin123`, etc.), plus fake demo products and 30 days of randomized fake transactions.
  Nothing gated this — no `NODE_ENV` check anywhere — so it could be run against a live production
  `DATABASE_URL` by accident with no warning.
- **[Blocker] No backup strategy existed anywhere.** No scripted or documented `pg_dump`/restore
  process, no managed-provider backup config, nothing.
- **[High] Leftover one-off scripts sat in the backend's deploy root with no safety gate:**
  `importRealData.js`, `importSalesData.js`, `importAugustSales.js`, `importAugustInventory.js`,
  `simulateSeptemberGap.js`, `cleanupDemoData.js` (store-specific, historical, assume a particular
  prior DB state), and `backfillStockBatches.js` / `backfillStockLedger.js` (idempotent,
  dry-run-by-default migration-support tools). `backend/data/` (~6.6MB of source Excel files) is
  **tracked by git** (an earlier version of this audit assumed otherwise — corrected 2026-09-28),
  so a naive "zip up backend/ and deploy" or "git clone and deploy" workflow drags it along.

### What was built

1. **Migration baseline.** Generated `prisma/migrations/20260928120000_sync_to_current_schema/` (the
   diff between the old init migration and the current `schema.prisma`, via
   `prisma migrate diff --from-migrations ... --to-schema ...`), then marked it applied on the real
   dev database with `prisma migrate resolve --applied` (the DB already had this schema from
   `db push`, so the file was never *executed* against it — only recorded). Verified for real: ran
   `prisma migrate deploy` against a brand-new throwaway database, then `prisma migrate diff
   --from-schema prisma/schema.prisma --to-config-datasource --exit-code` against it, which reported
   **"No difference detected."** `SHADOW_DATABASE_URL` (a dedicated empty DB) is now wired into
   `prisma.config.ts` and `.env.example`, required by `migrate dev`/`migrate diff` going forward.
   Day-to-day schema edits still use `prisma db push` as before; generate a matching migration file
   only when preparing a release (see Phase 4).
2. **Nightly backups.** `backend/services/backup.js` runs `pg_dump` (custom format, `-Fc`) on a
   node-cron schedule (`BACKUP_CRON`, default 01:30 store time — same pattern as the existing daily
   digest/forecast-snapshot crons in `index.js`), keeping a local rolling window (`BACKUP_DIR`,
   default `backend/backups/`, gitignored) and mirroring to `BACKUP_EXTERNAL_DIR` /
   `BACKUP_CLOUD_DIR` when those are set (each is skipped with a logged warning, not an error, if
   unconfigured — same "off by default, fails soft" pattern as `mailer.js`). Old dumps past
   `BACKUP_RETENTION_DAYS` (default 14) are pruned from all three locations. `PG_BIN_DIR` covers
   the common case where `pg_dump` isn't on `PATH` (not by default on Windows). **Restore is
   independently verified, not just the dump job**: `backend/scripts/restoreBackupTest.js` restores
   a dump into a brand-new throwaway database with `pg_restore`, checks row counts on a few core
   tables, then drops that database — safe to run against production since it never touches the
   real database. Ran live against a real dump of the dev database: restored 5 users, 1435
   products, 3480 transactions correctly.
3. **Script guard.** `backend/scripts/lib/productionGuard.js` exports `assertNotProduction(name)`,
   called first (right after `dotenv.config()`) by `scripts/seeder.js` and every script under
   `scripts/one-off/`; each refuses to run and exits 1 when `NODE_ENV=production`. Verified live:
   both the seeder and a one-off script correctly refused to run under `NODE_ENV=production`.
   `importRealData.js`, `importSalesData.js`, `importAugustSales.js`, `importAugustInventory.js`,
   `simulateSeptemberGap.js`, `cleanupDemoData.js`, `backfillStockBatches.js`, and
   `backfillStockLedger.js` moved from the backend root into `scripts/one-off/` (with a README);
   `seeder.js` moved into `scripts/` (its `package.json` reference and `CLAUDE.md`'s doc line were
   updated to match). Re-ran a moved import script in dry-run mode against the real data files to
   confirm the relocated paths still resolve — parsed 2119 matched line items correctly.
4. **First-admin bootstrap.** `backend/scripts/createFirstAdmin.js` creates one ADMIN user directly
   via Prisma (bypassing `UserModel.create`, which intentionally excludes `'ADMIN'` from
   `CREATABLE_ROLES` — the normal user-management UI can't create more admins, so this script is
   the sanctioned way around that for a fresh install). Generates a 16-character random password
   (same unambiguous alphabet as the existing "reset password" flow) and prints it once; refuses to
   run if the username is taken or an active admin already exists, unless `--force` is passed.
   Verified live: correctly rejected a duplicate username and a second admin without `--force`,
   then with `--force` created a working account whose password verified with `bcrypt.compare`
   (cleaned up afterward).
5. **Packaging exclusions.** `backend/scripts/DEPLOY_EXCLUDE.txt` documents the paths any future
   packaging/install script (Phase 4) must exclude: `backend/data/`, `backend/scripts/one-off/`,
   `backend/backups/`, `backend/.env`.

---

## Phase 1 — Deployment topology, config & terminal setup — DONE (2026-09-28)

Nothing here works once the app is hosted anywhere other than two `localhost` ports on one
machine, so this had to land before any real hosting decision is finalized. It also covered the
cashier-terminal and printer-sharing setup, now that both PCs are Windows 10.

### Findings (as originally audited — kept for record)

- **[Blocker] Frontend hardcoded `http://localhost:5000` directly in 18 files (30 occurrences).**
  Already fixed before this pass, discovered while starting this phase: `frontend/src/config.js`
  exports `SERVER_URL`/`API_BASE_URL` from `VITE_API_BASE_URL` (falling back to `localhost:5000`),
  and 21 files already import from it. No further work needed here.
- **[Blocker] Socket.IO server CORS was hardcoded** to a single dev origin. Also already partly
  fixed before this pass: it read `FRONTEND_URL` as additive origins. What was still missing (fixed
  now) was the REST API side.
- **[High] The REST API's CORS was wide open, not restricted** — `app.use(cors())` with no options
  reflected/allowed *any* request origin.
- **[Blocker] AI service had no auth enforced by default in production.** `AI_SERVICE_KEY` was
  optional with no environment-based requirement.
- **[High] No env validation at process startup.** A missing/empty `JWT_SECRET` only triggered a
  `console.warn`; a missing/wrong `DATABASE_URL` wasn't checked until the first query ran.
- **[High] `winRawPrintDriver.js` only supported `\\localhost\<share>`.** The printer stays on the
  cashier PC and the server needs to print to it remotely.
- **[Medium] No kiosk-style boot shortcut existed for the cashier PC(s).**

### What was built

1. **Frontend API base URL** — already done (see Findings above); verified no file still hardcodes
   `localhost:5000` directly.
2. **CORS, both sides, one setting.** `backend/index.js` now computes `allowedOrigins` once
   (`http://localhost:5173` plus comma-separated `FRONTEND_URL`) and uses it for **both**
   `app.use(cors({ origin: allowedOrigins }))` and Socket.IO's `cors.origin` (previously the REST
   side ignored it entirely). Verified live: a preflight `OPTIONS` request from
   `http://localhost:5173` got `204` with the origin echoed back; the same request from
   `http://evil.example.com` got no `Access-Control-Allow-Origin` header (rejected).
3. **Startup env validation, both services.** `backend/index.js` now hard-exits before any other
   module loads if `DATABASE_URL` is missing, `JWT_SECRET` is missing/short/still the placeholder,
   or (`NODE_ENV=production` only) `AI_SERVICE_KEY` is missing — printing every problem found, not
   just the first. `ai-service/main.py` mirrors the `AI_SERVICE_KEY` check using the same
   `NODE_ENV=production` flag, so one env var name means "production" in both services. Verified
   live: normal dev boot is unaffected; `NODE_ENV=production` without `AI_SERVICE_KEY` correctly
   refuses to start on both sides, with the exact fatal message printed.
4. **Remote printer share support.** `winRawPrintDriver.js` now checks whether the printer string
   is already a `\\HOST\share` UNC path (used as-is) or a bare share name (prefixed with
   `\\localhost\`, unchanged behavior). Confirmed node-thermal-printer's own `printer:` URI parsing
   passes a `\\CASHIER-PC\share` value through intact (its regex only splits on `/`, never `\`), and
   verified the resulting target-path logic for both forms. `print.md` gained a new "Printing from a
   separate server PC over the LAN" section with the exact remote-share setup and test steps.
5. **Kiosk boot shortcut.** `deploy/cashier-kiosk.bat` launches Edge (bundled with every Windows 10
   install, so no extra browser needed) in full kiosk mode (`--kiosk --edge-kiosk-type=fullscreen`)
   against the POS URL; dropping it into `shell:startup` runs it automatically at login. `POS_URL`
   is a placeholder pending the server's real LAN address (see Open items).
- **[Medium] `.env.example`'s example DB credential** finding was left as-is — cosmetic, not
  addressed this pass, still worth fixing when writing the real production `.env`.

---

## Phase 2 — Security hardening — DONE (2026-09-28), except one infra step

### Findings (as originally audited — kept for record)

- **[High] No `helmet` (or equivalent) anywhere** — no security headers at all.
- **[High] No general-purpose rate limiting.** The only throttle was
  `backend/services/loginThrottle.js` — in-memory, per-username (not per-IP); didn't stop an
  attacker spraying many different usernames from one IP.
- **[High] The login page displayed working dev credentials on screen, ungated.**
- **[Good, confirmed no action needed] Password/PIN hashing is solid** — bcrypt with 10 salt
  rounds, consistently applied; hashes never returned in API responses; login uses a timing-safe
  dummy-hash comparison for unknown usernames to prevent enumeration via response timing.
- **[Medium] `npm audit` findings:** 9 backend vulnerabilities, 6 frontend — see below for what
  was fixed vs. deliberately deferred.

### What was built

1. **`helmet`**, defaults, added to the backend middleware chain (first, before CORS/rate-limit/
   routes). Verified live: `Strict-Transport-Security`, `X-Content-Type-Options`,
   `X-Frame-Options`, `X-DNS-Prefetch-Control` all present on a real response.
2. **Two-layer rate limiting** (`express-rate-limit`), loose enough for a busy small-store shift
   per the chosen design: a general limiter (300 requests/15min per IP) applied globally, and a
   tighter login-specific limiter (10/15min per IP) layered in front of the existing per-username
   lockout — not replacing it. Verified live, both layers independently: the same username 5x
   tripped the pre-existing per-username lockout (429 from attempt 6); 10 different usernames from
   one IP tripped the new per-IP limiter (429 from attempt 11) — proving it now catches the gap
   the audit flagged (an attacker spraying many usernames from one IP).
3. **Login page credential hint removed outright** (`frontend/src/pages/ims/login.jsx`) — this
   project is headed to a real deployment, not staying a demo. Frontend still builds and lints
   clean (same pre-existing baseline error count, none new).
4. **Dependency fixes, non-breaking half only** (per the chosen scope — the `--force` fixes are a
   deliberate follow-up, not bundled in here): `npm audit fix` in both backend (`qs`/`fast-uri`
   cleared, 9 → 6 vulnerabilities) and frontend (`nanoid`/`react-router` cleared, 6 → 2). All 46
   backend tests, the frontend build, and frontend lint (identical error count before/after) still
   pass. `pip-audit` run against `ai-service/requirements.txt`: **no known vulnerabilities found**.
   **Deliberately not done:** the remaining `mysql2` (transitive, unused at runtime — this app uses
   Postgres) and `uuid` (via `exceljs`) vulnerabilities in both backend and frontend need
   `npm audit fix --force`, which `npm audit` reports would install **prisma@6.19.3** — a
   *downgrade* from the current 7.9.1, not an upgrade — plus `exceljs@3.4.0`, both breaking changes
   needing their own dedicated compatibility pass (schema/driver-adapter behavior, Excel export
   output) before ever being applied.
5. **Not done — infrastructure, not code.** A Windows Firewall rule restricting the backend/AI
   service to the store LAN, and Cloudflare Access in front of the Cloudflare Tunnel, both require
   the actual server PC and a chosen tunnel domain (still open items). Documented as install-time
   steps for Phase 5's go-live rehearsal rather than implemented now.

---

## Phase 3 — Observability & resilience — DONE (2026-09-28), except error monitoring (deferred)

### Findings (as originally audited — kept for record)

- **[High] No structured logging anywhere** — just scattered `console.error`/`console.log` (67
  occurrences in `index.js` alone, 19 more across models/services). No log levels.
- **[High] No crash/error monitoring** — no Sentry or equivalent dependency anywhere.
- **[Medium] No global `uncaughtException`/`unhandledRejection` handler** in `index.js`.
- **[Medium] No backend health-check endpoint at all.**
- **[Medium] No boot-time database connectivity check** — `server.listen()` succeeded and the
  process reported itself "running" even if Postgres was completely unreachable.
- **[Good, confirmed no action needed] AI-service unavailability is already handled gracefully** —
  `services/aiClient.js` has a 5s timeout, one retry on timeout/network/5xx, and a 3-failure
  circuit breaker (60s cooldown), falling back to a deterministic JS engine that mirrors the
  Python one. This path doesn't need rework.

### What was built

1. **Structured logging.** `backend/services/logger.js` wraps `pino`: pretty-printed to the console
   outside production, plain JSON lines to stdout under `NODE_ENV=production` (the chosen design —
   the process manager set up in Phase 4 redirects/rotates that into a file, so the app itself
   doesn't reimplement file rotation). All 115 `console.*` call sites across `index.js` (85) and 9
   models/services files were converted to leveled `logger.*` calls — verified with a full grep
   sweep confirming every file using `logger` also imports it (one gap caught and fixed:
   `models/Auth.js` had two converted calls but no import, which would have thrown at boot; fixed
   and re-verified by requiring the module directly). One exception, kept as `console.error`
   deliberately: the very first startup check (before any `require()` runs, so before `logger`
   exists) that prints a fatal misconfiguration message — pino's writes are async and could be lost
   if `process.exit()` fires before they flush, so a synchronous `console.error` right before exit
   is actually safer there.
2. **Crash handlers.** `process.on('uncaughtException', ...)` / `process.on('unhandledRejection', ...)`
   log the failure at `fatal` level with the full error, then exit — so a process manager (Phase 4)
   restarts cleanly instead of the process dying silently with no trace.
3. **`GET /api/health`** — no auth required (for a process supervisor/uptime monitor to poll), pings
   the database with `SELECT 1` and reports `{ status, db, uptimeSeconds }` (503 if the DB check
   fails). Verified live: `{"status":"ok","db":"connected","uptimeSeconds":2}`.
4. **Boot-time DB check with retry, per the chosen design.** `waitForDatabase()` retries up to 6
   times over ~18 seconds (giving Postgres time to finish starting when the process manager launches
   it and the backend around the same time on boot) before logging a fatal error and exiting.
   Verified live both ways: a normal boot passes through silently; pointed at an unreachable
   database, it logged 5 warnings ("attempt 1/6" .. "5/6") roughly 3 seconds apart, then a fatal
   error with the underlying Prisma error attached, and exited — exactly as designed.
5. **Error monitoring (Sentry or equivalent) — deliberately skipped**, per the chosen scope: it
   needs an external account and a DSN that don't exist yet. The logging and crash-handling above
   cover diagnosing issues on this single-store deployment without one; revisit if remote support
   ever needs it.

All 46 backend tests still pass throughout.

---

## Phase 4 — Packaging & CI — DONE (2026-09-28)

### Findings (as originally audited — kept for record)

- **[High] No process manager config anywhere for the chosen (non-Docker) Windows install.**
- **[Medium] The documented ai-service "production" start command used a dev-only flag** (`--reload`).
- **[Medium] The backend never served the frontend build** — no `express.static`/`sendFile`.
- **[Blocker for having a real deployment *process*, distinct from the app itself] No CI pipeline
  anywhere.**
- **[High] Test coverage was thin and one-sided** — zero coverage for auth, checkout, purchasing,
  or reconciliation, and nothing exercised `index.js`'s routes/middleware directly.
- **[Info, not a gap] `frontend/vite.config.js` sets `base: './'`**, portable for either hosting
  model — confirmed unaffected by this phase's changes.

### What was built

1. **Backend serves the built frontend.** `index.js` serves `frontend/dist` via `express.static`
   plus a regex SPA fallback (`/^\/(?!api\/|socket\.io\/).*/ ` → `index.html`, so client-side
   routing still works) — registered after every `/api` and `/socket.io` route so neither is ever
   shadowed. Only activates if `frontend/dist/index.html` actually exists (absent in today's
   two-process local dev, where the Vite dev server still serves the frontend on :5173 — that setup
   is completely unaffected). Verified live, all together: `/api/health` still returns JSON, `/`
   and a client-side route like `/adminDashboard` both correctly return `index.html`, a static
   asset returns with the right content-type, and `/socket.io/` still connects.
2. **Process manager: NSSM**, per the chosen option. `deploy/install-services.ps1` installs the
   backend and AI service as real Windows Services (`AimsBackend`, `AimsAiService`) — auto-start on
   boot with no login required, auto-restart on crash, NSSM's own log rotation (matching Phase 3's
   design: the app writes structured JSON to stdout only, the service wrapper handles the file).
   Syntax-verified by parsing the script. The AI service is started with
   `--host 127.0.0.1 --port 8000` (no `--reload`).
3. **CI pipeline.** `.github/workflows/ci.yml`, three jobs on every push to `main` and every PR:
   `backend` (a real Postgres 18 service container, `prisma migrate deploy` against it — proving the
   migration history actually works, per the chosen design — then `npm test`), `frontend`
   (`npm run lint`, `npm run build`), `ai-service` (`python -m unittest discover -s tests`).
4. **Auth and checkout integration tests, against a real database (per the chosen scope).** This
   needed one structural change first: `index.js`'s startup (binding the port, scheduling crons,
   verifying SMTP) is now guarded behind `require.main === module` and the file exports `{ app,
   server, io, prisma }` — so a test file can `require('../index.js')` to get a ready-to-use `app`
   for `supertest` without side effects. Verified this guard doesn't change normal behavior (`node
   index.js` still boots and logs identically) and that requiring it as a module starts nothing.
   `backend/test/auth.test.js` (5 tests: correct login, wrong password, unknown username, a
   deactivated account, a protected route with no token) and `backend/test/checkout.test.js` (6
   tests: role gating, empty cart, unknown product, insufficient stock leaving stock unchanged, a
   real sale correctly decrementing stock and totaling the right amount, a card sale missing its
   required reference number) — all against real fixtures created and torn down per file. Backend
   test count: 46 → 57, all passing; confirmed no fixture rows were left behind afterward.
5. **Install runbook.** `deploy/INSTALL.md`, a step-by-step walkthrough from a bare Windows 10
   server PC through prerequisites, database setup and migration, the first-admin bootstrap,
   frontend build, AI service setup, printer setup (linking `print.md`), backups, installing the
   Windows services, a Firewall rule, cashier PC kiosk setup, remote access, the Phase 5 rehearsal,
   and an update procedure for later.

All 57 backend tests, frontend lint/build, and all 76 ai-service tests still pass throughout.

---

## Status

**Phases 0-4 are done** (2026-09-28) — data safety net, topology/config/terminal setup, security
hardening, observability/resilience, and packaging/CI. Everything in each phase above was verified
live (against the real dev database and, where relevant, a live-booted server), not just written
and assumed correct. Nothing has been committed to git; that's left for whenever it's asked for.

**Phase 5 (go-live rehearsal) is the only phase left, and it's inherently hands-on** — it needs the
actual store server PC, the TM-T82X printer wired up, and a cashier PC on the same LAN, none of
which exist in this environment. `deploy/INSTALL.md` is the runbook to follow once that hardware is
ready; Phase 5 above lists what the rehearsal itself needs to prove (checkout/X-Reading/Z-Reading/
void slip printing across the LAN, offline behavior, a working rollback).

Two open items still block parts of the install: the Cloudflare Tunnel's domain name (needed before
`INSTALL.md` step 12) and the cloud-folder provider for off-site backups (needed before step 8) —
see "Open items" near the top of this document.

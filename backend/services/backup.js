// Nightly database backup: dumps Postgres with pg_dump (custom format, restorable with pg_restore),
// keeps a local rolling window of copies, and mirrors each dump to an external drive and/or a cloud
// sync folder when those are configured. Off/soft by default like mailer.js and receiptPrinter.js:
// a missing pg_dump or an unconfigured off-site path logs a warning instead of throwing, so a store
// that hasn't finished setting up off-site copies still gets local backups every night.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_RETENTION_DAYS = 14;
const FILE_PREFIX = 'aims-backup-';
const FILE_EXT = '.dump';

const localDir = () => process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const externalDir = () => process.env.BACKUP_EXTERNAL_DIR || null;
const cloudDir = () => process.env.BACKUP_CLOUD_DIR || null;
const retentionDays = () => {
  const n = Number(process.env.BACKUP_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
};

// pg_dump/pg_restore aren't always on PATH (they aren't added there by a default Windows Postgres
// install). Set PG_BIN_DIR to the Postgres "bin" folder if so; otherwise both are assumed to be on PATH.
const pgBinary = (name) => {
  const dir = process.env.PG_BIN_DIR;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : name;
};

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Prisma's DATABASE_URL carries a `schema` query param that pg_dump doesn't understand (it errors
// on any query param it doesn't recognize). Strip it and pass the schema via pg_dump's own -n flag
// instead, so the same DATABASE_URL used everywhere else in the app also works here unmodified.
function pgDumpConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') || 'public';
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function copyIfConfigured(filePath, destDir, label, warnings) {
  if (!destDir) {
    warnings.push(`${label} not configured (set the env var to enable) — skipped.`);
    return null;
  }
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(filePath));
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (err) {
    warnings.push(`${label} copy failed: ${err.message}`);
    return null;
  }
}

// Deletes files older than the retention window from a directory. Never throws — a prune failure
// (e.g. an external drive unplugged) shouldn't fail the backup that just succeeded.
function pruneOldBackups(dir) {
  if (!dir) return 0;
  let removed = 0;
  try {
    const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_EXT)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    }
  } catch {
    // best-effort — a missing/unreachable directory just means nothing to prune there
  }
  return removed;
}

// Runs pg_dump, mirrors the dump to the external/cloud folders when configured, and prunes backups
// older than the retention window everywhere. Resolves with a summary; never throws for a
// missing off-site destination (those become warnings), but does throw if pg_dump itself fails.
async function runBackup() {
  const dir = localDir();
  fs.mkdirSync(dir, { recursive: true });

  const fileName = `${FILE_PREFIX}${timestamp()}${FILE_EXT}`;
  const filePath = path.join(dir, fileName);
  const warnings = [];

  const { connectionString, schema } = pgDumpConnection(process.env.DATABASE_URL);
  await run(pgBinary('pg_dump'), ['-Fc', '-n', schema, '-f', filePath, connectionString]);
  const sizeBytes = fs.statSync(filePath).size;

  const copiedTo = [];
  const externalPath = copyIfConfigured(filePath, externalDir(), 'BACKUP_EXTERNAL_DIR', warnings);
  if (externalPath) copiedTo.push(externalPath);
  const cloudPath = copyIfConfigured(filePath, cloudDir(), 'BACKUP_CLOUD_DIR', warnings);
  if (cloudPath) copiedTo.push(cloudPath);

  const prunedLocal = pruneOldBackups(dir);
  const prunedExternal = pruneOldBackups(externalDir());
  const prunedCloud = pruneOldBackups(cloudDir());

  return {
    file: filePath,
    sizeBytes,
    copiedTo,
    warnings,
    pruned: prunedLocal + prunedExternal + prunedCloud,
  };
}

module.exports = { runBackup, pgBinary, localDir, externalDir, cloudDir, retentionDays };

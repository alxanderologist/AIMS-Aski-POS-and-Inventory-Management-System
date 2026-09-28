// Proves a backup dump is actually restorable — not just that pg_dump succeeded. Restores it into a
// brand-new, throwaway database (never the real one), runs a couple of sanity checks, then drops
// that throwaway database. Safe to run against a production server: it never touches DATABASE_URL's
// own database, only a temporary sibling it creates and destroys itself.
//
// Usage:
//   node scripts/restoreBackupTest.js [path-to-dump]     defaults to the newest file in BACKUP_DIR
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const backup = require('../services/backup');

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

function bin(name) {
  return backup.pgBinary(name);
}

// Connects to the `postgres` maintenance database (needed for CREATE/DROP DATABASE — you can't run
// those against the database you're connected to) and strips Prisma's `schema` query param, which
// none of the pg_* CLI tools understand.
function maintenanceConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  url.pathname = '/postgres';
  return url.toString();
}

function connectionFor(databaseUrl, dbName) {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  url.pathname = `/${dbName}`;
  return url.toString();
}

function latestDumpFile() {
  const dir = backup.localDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('aims-backup-') && f.endsWith('.dump'))
    .map((f) => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No backup files found in ${dir}. Run a backup first, or pass a dump path.`);
  return files[0].full;
}

async function main() {
  const dumpPath = process.argv[2] || latestDumpFile();
  if (!fs.existsSync(dumpPath)) throw new Error(`Dump file not found: ${dumpPath}`);
  console.log(`Testing restore of: ${dumpPath}`);

  const tempDbName = `aims_restore_test_${Date.now()}`;
  const maintConn = maintenanceConnection(process.env.DATABASE_URL);
  const tempConn = connectionFor(process.env.DATABASE_URL, tempDbName);

  console.log(`Creating throwaway database "${tempDbName}"...`);
  await run(bin('psql'), [maintConn, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${tempDbName}"`]);

  try {
    console.log('Restoring dump into it...');
    // --clean --if-exists: a brand-new database already has a "public" schema, so pg_restore's own
    // CREATE SCHEMA statement for it would otherwise fail; these flags have it drop-then-recreate
    // instead, which is harmless here since nothing else has been created in this throwaway database.
    await run(bin('pg_restore'), ['-d', tempConn, '--no-owner', '--no-privileges', '--clean', '--if-exists', dumpPath]);

    console.log('Running sanity checks...');
    const tables = ['User', 'Product', 'Transaction'];
    for (const table of tables) {
      const { stdout } = await run(bin('psql'), [tempConn, '-t', '-A', '-c', `SELECT count(*) FROM "${table}"`]);
      console.log(`  ${table}: ${stdout.trim()} row(s)`);
    }

    console.log('\nRestore test PASSED — the backup is restorable.');
  } finally {
    console.log(`Dropping throwaway database "${tempDbName}"...`);
    await run(bin('psql'), [maintConn, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${tempDbName}"`]);
  }
}

main().catch((err) => {
  console.error('Restore test FAILED:', err.message, err.stderr || '');
  process.exitCode = 1;
});

// Refuses to run when NODE_ENV=production, so a destructive or store-specific one-off script
// can't be fired against live data by accident. Call this first, right after `dotenv.config()`
// and before any Prisma/DB access.
function assertNotProduction(scriptName) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `${scriptName} refuses to run with NODE_ENV=production. This script is for local/staging ` +
      'use only — it is not safe to run against live data.'
    );
    process.exit(1);
  }
}

module.exports = { assertNotProduction };

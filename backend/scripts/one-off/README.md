# One-off scripts

These are store-specific, historical, or migration-support scripts — not part of the running
application and not safe to run blind against production data. Each one:

- Refuses to run when `NODE_ENV=production` (see `../lib/productionGuard.js`).
- Documents its own usage (dry-run vs `--commit`, and any `--revert`) in a header comment.
- Assumes a particular prior database state (an earlier import already ran, a specific month's
  data files exist under `backend/data/`, etc.) — read the header comment before running one.

| Script | Purpose |
| --- | --- |
| `importRealData.js` | July 2026 baseline import (Coop Store + Coke Talavera products/stock). |
| `importSalesData.js` | May–July 2026 historical sales import. |
| `importAugustSales.js` | August 2026 historical sales import. |
| `importAugustInventory.js` | August 2026 physical recount (stock/cost/price corrections + new products). |
| `simulateSeptemberGap.js` | Fills a September 2026 sales-history gap with synthetic, Poisson-sampled transactions (tagged `SIM-*`) so the demand forecast has something to learn from. `--revert` removes them. |
| `cleanupDemoData.js` | Removes `seeder.js`'s demo products/suppliers/transactions once real data has been imported. |
| `backfillStockBatches.js` | One-time backfill of opening `StockBatch` rows for FIFO costing. |
| `backfillStockLedger.js` | One-time backfill of opening `StockMovement` rows for the stock ledger. |

None of these are wired into `npm run` scripts on purpose — run them directly with `node`, from
`backend/`, e.g. `node scripts/one-off/backfillStockLedger.js`.

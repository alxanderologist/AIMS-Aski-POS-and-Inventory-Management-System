// One-off backfill: batch cost tracking (StockBatch) is a new feature, so every product that
// already has stock on hand needs one "opening balance" batch (today's date, current costPrice)
// before FIFO consumption has anything to draw from. Safe to re-run — it skips any product that
// already has a batch, so it can never double-count.
//
// Usage: node backfillStockBatches.js [--commit]
// Dry run by default; --commit actually writes the batches.

require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('backfillStockBatches.js');

const { prisma } = require('../../models/Product');

async function main() {
  const commit = process.argv.includes('--commit');

  const products = await prisma.product.findMany({
    where: { stock: { gt: 0 } },
    select: { id: true, name: true, stock: true, costPrice: true, supplierId: true },
  });

  const alreadyBatched = new Set(
    (await prisma.stockBatch.findMany({ select: { productId: true }, distinct: ['productId'] })).map((b) => b.productId),
  );

  const toBackfill = products.filter((p) => !alreadyBatched.has(p.id));

  console.log(`${products.length} products have stock on hand; ${toBackfill.length} need an opening batch.`);
  if (toBackfill.length === 0) {
    console.log('Nothing to do.');
    return;
  }
  for (const p of toBackfill.slice(0, 10)) {
    console.log(`  #${p.id} ${p.name} — stock ${p.stock} @ cost ${p.costPrice}`);
  }
  if (toBackfill.length > 10) console.log(`  ...and ${toBackfill.length - 10} more`);

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to write these batches.');
    return;
  }

  await prisma.$transaction(
    toBackfill.map((p) =>
      prisma.stockBatch.create({
        data: {
          productId: p.id,
          supplierId: p.supplierId,
          unitCost: p.costPrice,
          qtyReceived: p.stock,
          qtyRemaining: p.stock,
          referenceType: 'Opening',
          referenceNo: 'Opening balance (batch tracking backfill)',
        },
      }),
    ),
  );
  console.log(`\nCreated ${toBackfill.length} opening batches.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

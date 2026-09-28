// One-off, idempotent: gives every product that has stock but no ledger history an OPENING movement
// dated at the product's creation, so the ledger balances from day one. Safe to re-run.
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('backfillStockLedger.js');

const { prisma } = require('../../models/Product');

async function backfill() {
  const products = await prisma.product.findMany({
    where: { stock: { gt: 0 }, stockMovements: { none: {} } },
    select: { id: true, stock: true, createdAt: true },
  });

  if (products.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  await prisma.stockMovement.createMany({
    data: products.map((p) => ({
      productId: p.id,
      type: 'OPENING',
      quantity: p.stock,
      balanceAfter: p.stock,
      reason: 'Opening balance (backfilled)',
      createdAt: p.createdAt,
    })),
  });
  console.log(`Backfilled ${products.length} opening balance(s).`);
}

backfill()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

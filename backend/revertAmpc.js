/**
 * Revert everything importAmpc.js wrote to the database.
 *
 * What this removes (in order, respecting FK dependencies):
 *   · ReceivingReport / ReceivingReportItem where rrNumber starts with "AMPCRR-"
 *   · PurchaseOrder / PurchaseOrderItem where poNumber starts with "AMPCPO-"
 *   · Transaction / TransactionItem where transactionNo starts with "AMPC-"
 *   · Supplier rows named "AMPC · …" (branch suppliers auto-created on import)
 *   · Products that (a) point at the "AMPC Import (May–July 2026)" supplier
 *     AND (b) have no remaining foreign references anywhere else. Products
 *     already referenced elsewhere are left in place.
 *   · The anchor supplier itself, once no product still points at it.
 *
 * Nothing else is touched. Products the user was already using (e.g. the
 * original seed catalog) stay put.
 *
 * Run:   node revertAmpc.js
 */
require('dotenv').config();
const { prisma } = require('./models/Product');

async function main() {
  console.log('== Reverting AMPC import ==');

  // 1. Receiving report items cascade with the receiving report.
  const rrDel = await prisma.receivingReport.deleteMany({
    where: { rrNumber: { startsWith: 'AMPCRR-' } },
  });
  console.log(`  receiving reports removed: ${rrDel.count}`);

  // 2. Purchase-order items cascade with the PO.
  const poDel = await prisma.purchaseOrder.deleteMany({
    where: { poNumber: { startsWith: 'AMPCPO-' } },
  });
  console.log(`  purchase orders removed: ${poDel.count}`);

  // 3. Transaction items cascade with the transaction.
  const txDel = await prisma.transaction.deleteMany({
    where: { transactionNo: { startsWith: 'AMPC-' } },
  });
  console.log(`  transactions removed: ${txDel.count}`);

  // 4. Branch suppliers auto-created by the importer (naming prefix "AMPC · ").
  const brSup = await prisma.supplier.deleteMany({
    where: { name: { startsWith: 'AMPC · ' } },
  });
  console.log(`  branch suppliers removed: ${brSup.count}`);

  // 5. Products the importer created (anchored to the AMPC seed supplier)
  //    only when nothing else still references them.
  const anchor = await prisma.supplier.findFirst({
    where: { name: 'AMPC Import (May–July 2026)' },
  });
  if (anchor) {
    const linked = await prisma.product.findMany({
      where: { supplierId: anchor.id },
      select: {
        id: true,
        _count: {
          select: {
            transactionItems: true,
            purchaseOrderItems: true,
            receivingReportItems: true,
            purchaseReturnItems: true,
          },
        },
      },
    });
    const orphanIds = linked
      .filter((p) => {
        const c = p._count;
        return (
          c.transactionItems === 0 &&
          c.purchaseOrderItems === 0 &&
          c.receivingReportItems === 0 &&
          c.purchaseReturnItems === 0
        );
      })
      .map((p) => p.id);
    if (orphanIds.length) {
      const pd = await prisma.product.deleteMany({ where: { id: { in: orphanIds } } });
      console.log(`  orphan products removed: ${pd.count}`);
    } else {
      console.log('  no orphan products to remove');
    }

    // 6. Anchor supplier, if no product still points at it.
    const stillLinked = await prisma.product.count({ where: { supplierId: anchor.id } });
    if (stillLinked === 0) {
      await prisma.supplier.delete({ where: { id: anchor.id } });
      console.log('  anchor supplier removed');
    } else {
      console.log(`  anchor supplier kept (${stillLinked} products still reference it)`);
    }
  }

  console.log('== Revert complete ==');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

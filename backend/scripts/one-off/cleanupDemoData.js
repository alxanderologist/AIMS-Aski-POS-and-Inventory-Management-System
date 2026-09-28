// One-off: removes seeder.js's demo/mock data (and leftover test artifacts from earlier live
// testing) now that the database also holds real imported data. Keeps the 5 login accounts
// (admin/cashier/supervisor/accounting/inventory) so the app stays usable.
//
// Scope removed: the 10 demo products + 3 demo suppliers from seeder.js, the "Jollibee Food
// Corporation" test supplier and its 3 test PurchaseOrders / 2 test ReceivingReports (leftovers
// from earlier phase testing), all Transactions/TransactionItems and Reconciliations (100% demo —
// no real transactions have been imported), their StockMovements, and all cached ForecastSnapshots
// (derived from the demo sales history; they regenerate automatically).
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('cleanupDemoData.js');

const { prisma } = require('../../models/Product');

const DEMO_SUPPLIER_NAMES = ['Alpha Distributing Co.', 'Global Goods Inc.', 'Prime Wholesale Ltd.', 'Jollibee Food Corporation'];

async function cleanup() {
  const demoProducts = await prisma.product.findMany({ where: { barcode: { startsWith: '4800001' } }, select: { id: true } });
  const demoProductIds = demoProducts.map((p) => p.id);
  const demoSuppliers = await prisma.supplier.findMany({ where: { name: { in: DEMO_SUPPLIER_NAMES } }, select: { id: true, name: true } });
  const demoSupplierIds = demoSuppliers.map((s) => s.id);

  console.log(`Found ${demoProductIds.length} demo products, ${demoSupplierIds.length} demo/test suppliers.`);

  const snapItems = await prisma.forecastSnapshotItem.deleteMany({});
  const snaps = await prisma.forecastSnapshot.deleteMany({});
  console.log(`Deleted ${snapItems.count} forecast snapshot items, ${snaps.count} forecast snapshots.`);

  const rrs = await prisma.receivingReport.findMany({ where: { supplierId: { in: demoSupplierIds } }, select: { id: true } });
  const rrIds = rrs.map((r) => r.id);
  const rrItems = await prisma.receivingReportItem.deleteMany({ where: { receivingReportId: { in: rrIds } } });
  const rrDeleted = await prisma.receivingReport.deleteMany({ where: { id: { in: rrIds } } });
  console.log(`Deleted ${rrItems.count} receiving report items, ${rrDeleted.count} receiving reports.`);

  const pos = await prisma.purchaseOrder.findMany({ where: { supplierId: { in: demoSupplierIds } }, select: { id: true } });
  const poIds = pos.map((o) => o.id);
  const poItems = await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
  const poDeleted = await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
  console.log(`Deleted ${poItems.count} purchase order items, ${poDeleted.count} purchase orders.`);

  const prs = await prisma.purchaseReturn.findMany({ where: { supplierId: { in: demoSupplierIds } }, select: { id: true } });
  const prIds = prs.map((r) => r.id);
  const prItems = await prisma.purchaseReturnItem.deleteMany({ where: { purchaseReturnId: { in: prIds } } });
  const prDeleted = await prisma.purchaseReturn.deleteMany({ where: { id: { in: prIds } } });
  console.log(`Deleted ${prItems.count} purchase return items, ${prDeleted.count} purchase returns.`);

  const txItems = await prisma.transactionItem.deleteMany({});
  const txs = await prisma.transaction.deleteMany({});
  console.log(`Deleted ${txItems.count} transaction items, ${txs.count} transactions.`);

  const recs = await prisma.reconciliation.deleteMany({});
  console.log(`Deleted ${recs.count} reconciliations.`);

  const movements = await prisma.stockMovement.deleteMany({ where: { productId: { in: demoProductIds } } });
  console.log(`Deleted ${movements.count} stock movements for demo products.`);

  const products = await prisma.product.deleteMany({ where: { id: { in: demoProductIds } } });
  console.log(`Deleted ${products.count} demo products.`);

  const suppliers = await prisma.supplier.deleteMany({ where: { id: { in: demoSupplierIds } } });
  console.log(`Deleted ${suppliers.count} demo/test suppliers.`);

  const remainingProducts = await prisma.product.count();
  const remainingSuppliers = await prisma.supplier.count();
  const remainingUsers = await prisma.user.count();
  console.log(`\nRemaining: ${remainingProducts} products, ${remainingSuppliers} suppliers, ${remainingUsers} users (login accounts kept).`);
}

cleanup()
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

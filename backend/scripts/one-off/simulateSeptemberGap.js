// One-off fill for the September 2026 sales gap (no real POS data was recorded for a stretch of days
// after the August import, which collapses the demand forecast to 0/-100%). For each store-local day in
// September that currently has NO transactions at all, this generates one synthetic Transaction per day,
// with a per-product quantity sampled from a Poisson distribution around that product's real August 2026
// daily average (so slow movers don't sell every single day, and volume stays grounded in real history).
//
// Deliberately does NOT touch Product.stock or write any StockMovement rows (today's on-hand stock
// already reflects physical reality) — this is sales/revenue history for the forecast engine to learn
// from, same as importAugustSales.js.
//
// Every synthetic transaction is tagged `SIM-YYYYMMDD` (transactionNo) so it can be found and removed
// later with a single query if real September POS data is ever imported for the same dates.
//
// Usage:
//   node simulateSeptemberGap.js            dry run — computes everything, prints a report, writes nothing
//   node simulateSeptemberGap.js --commit   actually creates the synthetic Transactions/TransactionItems
//   node simulateSeptemberGap.js --revert   deletes every SIM-* transaction (and its items, via cascade)
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('simulateSeptemberGap.js');

const { prisma } = require('../../models/Product');

const COMMIT = process.argv.includes('--commit');
const REVERT = process.argv.includes('--revert');
const CASHIER_USERNAME = 'admin';
const STORE_TIMEZONE_NOON_UTC_HOUR = 4; // 12:00 Asia/Manila (UTC+8) == 04:00 UTC
const TXN_PREFIX = 'SIM-';
const AUGUST_START = new Date(Date.UTC(2026, 7, 1, 0, 0, 0)); // 2026-08-01
const AUGUST_DAYS = 31;
const FILL_MONTH_START = new Date(Date.UTC(2026, 8, 1, 0, 0, 0)); // 2026-09-01
// Never simulate "today" (still in progress) or any future day — cap at yesterday, store-local.
const fillEndCandidate = new Date(Date.UTC(2026, 8, 30, 0, 0, 0)); // 2026-09-30, the nominal month end
const manilaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const yesterday = new Date(Date.parse(`${manilaToday}T00:00:00Z`) - 86400000);
const FILL_MONTH_END = yesterday < fillEndCandidate ? yesterday : fillEndCandidate;

const ymd = (d) => d.toISOString().slice(0, 10);
const noonUtcFor = (dateOnlyUtc) =>
  new Date(Date.UTC(dateOnlyUtc.getUTCFullYear(), dateOnlyUtc.getUTCMonth(), dateOnlyUtc.getUTCDate(), STORE_TIMEZONE_NOON_UTC_HOUR, 0, 0));

// Knuth's algorithm; fine for the small/moderate per-day rates real convenience-store products see.
function samplePoisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

async function revert() {
  const existing = await prisma.transaction.findMany({
    where: { transactionNo: { startsWith: TXN_PREFIX } },
    select: { id: true, transactionNo: true },
  });
  console.log(`Found ${existing.length} simulated transaction(s) tagged "${TXN_PREFIX}*".`);
  if (existing.length === 0) return;
  if (!COMMIT) {
    console.log('Dry run — re-run with `--revert --commit` to actually delete them.');
    return;
  }
  const { count } = await prisma.transaction.deleteMany({ where: { id: { in: existing.map((t) => t.id) } } });
  console.log(`Deleted ${count} transaction(s) (their items cascaded automatically).`);
}

async function main() {
  if (REVERT) {
    await revert();
    return;
  }

  console.log(COMMIT ? 'Running in COMMIT mode — this will write to the database.\n' : 'Running in DRY RUN mode — no database writes.\n');

  const cashier = await prisma.user.findUnique({ where: { username: CASHIER_USERNAME } });
  if (!cashier) throw new Error(`Cashier account "${CASHIER_USERNAME}" not found`);

  // Real September days that already have at least one transaction (real sales, or a prior HIST-*
  // import) — these are left alone. Anything from a previous SIM-* run is excluded from this check so
  // the script stays idempotent (a re-run recomputes gap days from scratch, not "days I already filled").
  const existingDays = await prisma.$queryRaw`
    SELECT DISTINCT ("createdAt" AT TIME ZONE 'Asia/Manila')::date AS day
    FROM "Transaction"
    WHERE "createdAt" >= ${FILL_MONTH_START} AND "createdAt" < ${new Date(FILL_MONTH_END.getTime() + 86400000)}
      AND "transactionNo" NOT LIKE ${TXN_PREFIX + '%'}
  `;
  const realDaySet = new Set(existingDays.map((r) => ymd(r.day)));

  const gapDays = [];
  for (let d = new Date(FILL_MONTH_START); d <= FILL_MONTH_END; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = ymd(d);
    if (!realDaySet.has(key)) gapDays.push(new Date(d));
  }
  console.log(`September days with real sales already: ${realDaySet.size}`);
  console.log(`Gap days to simulate: ${gapDays.length} (${gapDays.length ? `${ymd(gapDays[0])} .. ${ymd(gapDays[gapDays.length - 1])}` : 'none'})`);
  if (gapDays.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Real August 2026 sales per product: total quantity (-> daily rate over all 31 calendar days) and
  // the average unit price actually charged, so simulated revenue matches real August pricing.
  const augItems = await prisma.transactionItem.findMany({
    where: { transaction: { createdAt: { gte: AUGUST_START, lt: FILL_MONTH_START } } },
    select: { productId: true, quantity: true, unitPrice: true },
  });
  const statsByProduct = new Map(); // productId -> { qty, revenue }
  for (const it of augItems) {
    const s = statsByProduct.get(it.productId) || { qty: 0, revenue: 0 };
    s.qty += it.quantity;
    s.revenue += it.quantity * Number(it.unitPrice);
    statsByProduct.set(it.productId, s);
  }
  const products = await prisma.product.findMany({ select: { id: true, barcode: true, name: true } });
  const byId = new Map(products.map((p) => [p.id, p]));

  const rateByProduct = [];
  for (const [productId, s] of statsByProduct) {
    if (!byId.has(productId) || s.qty <= 0) continue;
    rateByProduct.push({
      product: byId.get(productId),
      dailyRate: s.qty / AUGUST_DAYS,
      avgUnitPrice: Math.round((s.revenue / s.qty) * 100) / 100,
      augustQty: s.qty,
    });
  }
  console.log(`Products with real August sales to base the simulation on: ${rateByProduct.length}`);

  const dayPlans = [];
  let totalLines = 0;
  let totalRevenue = 0;
  for (const day of gapDays) {
    const lines = [];
    for (const r of rateByProduct) {
      const qty = samplePoisson(r.dailyRate);
      if (qty <= 0) continue;
      const subtotal = Math.round(qty * r.avgUnitPrice * 100) / 100;
      lines.push({ product: r.product, quantity: qty, unitPrice: r.avgUnitPrice, subtotal });
    }
    if (lines.length === 0) continue; // extremely unlikely, but keep the invariant "every SIM- txn has items"
    const subtotal = Math.round(lines.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100;
    dayPlans.push({ day, transactionNo: `${TXN_PREFIX}${ymd(day).replace(/-/g, '')}`, lines, subtotal });
    totalLines += lines.length;
    totalRevenue += subtotal;
  }

  console.log(`\n=== Plan ===`);
  console.log(`Synthetic transactions (1 per gap day): ${dayPlans.length}`);
  console.log(`Total line items: ${totalLines}`);
  console.log(`Total simulated revenue: ₱${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log('Sample day:', dayPlans[0] && { date: ymd(dayPlans[0].day), items: dayPlans[0].lines.length, subtotal: dayPlans[0].subtotal });

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to write these to the database.');
    return;
  }

  console.log('\n=== Committing to database ===');
  let created = 0;
  let createdItems = 0;
  for (const plan of dayPlans) {
    await prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.create({
        data: {
          transactionNo: plan.transactionNo,
          subtotal: plan.subtotal,
          discountAmount: 0,
          discountPercent: 0,
          supervisorAuthorized: false,
          totalAmount: plan.subtotal,
          paymentMethod: 'CASH',
          cashierId: cashier.id,
          createdAt: noonUtcFor(plan.day),
        },
      });
      await tx.transactionItem.createMany({
        data: plan.lines.map((l) => ({
          transactionId: txn.id,
          productId: l.product.id,
          barcode: l.product.barcode,
          name: l.product.name,
          unitPrice: l.unitPrice,
          quantity: l.quantity,
          subtotal: l.subtotal,
        })),
      });
      createdItems += plan.lines.length;
    });
    created += 1;
  }
  console.log(`Created ${created} synthetic transactions, ${createdItems} transaction items.`);
  console.log('Product.stock was not touched — these are simulated history only, tagged "SIM-*".');
}

main()
  .catch((error) => {
    console.error('Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

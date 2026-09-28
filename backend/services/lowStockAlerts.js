// Low-stock alert logic: uses each product's per-row `minStock` (from the
// Product model) as the reorder level, not a global constant. A crossing is
// a sale that pushes stock from above minStock to at or below it.

const { prisma } = require('../models/Product');
const logger = require('./logger');
const mailer = require('./mailer');

/**
 * From a list of updates produced by a checkout (each entry carries the
 * product's per-row `minStock`, the post-sale `newStock`, and the `quantity`
 * sold), return only those whose stock crossed minStock downward this sale.
 */
function detectCrossings(stockUpdates) {
  return stockUpdates
    .filter((u) => {
      const oldStock = u.newStock + u.quantity;
      return oldStock > u.minStock && u.newStock <= u.minStock;
    })
    .map((u) => ({
      id: u.id,
      name: u.name,
      category: u.category,
      stock: u.newStock,
      minStock: u.minStock,
    }));
}

async function notifyCrossings(crossings) {
  if (!crossings || crossings.length === 0) return;
  if (!mailer.isConfigured()) return;
  try {
    const res = await mailer.sendLowStockAlert(crossings);
    if (res && res.messageId) {
      logger.info(
        `[low-stock] sent crossing alert for ${crossings.length} product(s) — ${res.messageId}`,
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, '[low-stock] alert send failed');
  }
}

async function findCurrentlyLow() {
  // stock <= minStock, using a raw where because Prisma has no column-vs-column.
  const rows = await prisma.$queryRaw`
    SELECT id, name, category, stock, "minStock"
    FROM "Product"
    WHERE stock <= "minStock"
    ORDER BY stock ASC, name ASC
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    category: r.category,
    stock: Number(r.stock),
    minStock: Number(r.minStock),
  }));
}

async function sendDigestNow() {
  const products = await findCurrentlyLow();
  if (products.length === 0) {
    logger.info('[low-stock] digest: no low-stock products, nothing to send.');
    return { count: 0 };
  }
  const res = await mailer.sendLowStockDigest(products);
  if (res && res.messageId) {
    logger.info(`[low-stock] sent digest for ${products.length} product(s) — ${res.messageId}`);
  }
  return { count: products.length, ...res };
}

module.exports = {
  detectCrossings,
  notifyCrossings,
  findCurrentlyLow,
  sendDigestNow,
};

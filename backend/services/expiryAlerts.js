// Expiry alert logic: warns when a product's expiryDate enters an
// EXPIRY_WARN_DAYS window (default 30) or is already past.

const { prisma } = require('../models/Product');
const logger = require('./logger');
const mailer = require('./mailer');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getWindowDays() {
  const raw = Number(process.env.EXPIRY_WARN_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(date) {
  if (!date) return null;
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - startOfToday()) / MS_PER_DAY);
}

function windowEnd() {
  const d = startOfToday();
  d.setDate(d.getDate() + getWindowDays());
  return d;
}

/**
 * Return true only when this update moved the expiry from unset (or outside
 * the warning window) to inside it. Already-inside edits do not re-fire.
 */
function detectExpiryCrossing(beforeDate, afterDate) {
  if (!afterDate) return false;
  const afterDays = daysUntil(afterDate);
  if (afterDays === null) return false;
  const windowDays = getWindowDays();

  const wasWatched = beforeDate
    ? (() => {
        const beforeDays = daysUntil(beforeDate);
        return beforeDays !== null && beforeDays <= windowDays;
      })()
    : false;

  const isWatched = afterDays <= windowDays;
  return isWatched && !wasWatched;
}

async function findExpiringSoon() {
  const cutoff = windowEnd();
  const products = await prisma.product.findMany({
    where: { expiryDate: { not: null, lte: cutoff } },
    orderBy: [{ expiryDate: 'asc' }],
    select: { id: true, name: true, category: true, expiryDate: true, stock: true },
  });
  return products.map((p) => ({ ...p, daysUntilExpiry: daysUntil(p.expiryDate) }));
}

async function notifyExpiryCrossing(product) {
  if (!product) return;
  if (!mailer.isConfigured()) return;
  try {
    const enriched = { ...product, daysUntilExpiry: daysUntil(product.expiryDate) };
    const res = await mailer.sendExpiryAlert(enriched, getWindowDays());
    if (res && res.messageId) {
      logger.info(
        `[expiry] sent crossing alert for "${product.name}" (${enriched.daysUntilExpiry} days) — ${res.messageId}`,
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, '[expiry] alert send failed');
  }
}

async function sendDigestNow() {
  const products = await findExpiringSoon();
  if (products.length === 0) {
    logger.info('[expiry] digest: no products within window, nothing to send.');
    return { count: 0 };
  }
  const res = await mailer.sendExpiryDigest(products, getWindowDays());
  if (res && res.messageId) {
    logger.info(`[expiry] sent digest for ${products.length} product(s) — ${res.messageId}`);
  }
  return { count: products.length, ...res };
}

module.exports = {
  getWindowDays,
  daysUntil,
  detectExpiryCrossing,
  findExpiringSoon,
  notifyExpiryCrossing,
  sendDigestNow,
};

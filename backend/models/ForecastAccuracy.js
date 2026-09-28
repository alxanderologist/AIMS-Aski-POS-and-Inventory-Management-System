const { postJson } = require('../services/aiClient');
const logger = require('../services/logger');
const { prisma } = require('./Product');
const { loadDailySales } = require('./salesHistory');
const { loadForecastInput, STORE_TIMEZONE, localDate, PYTHON_AI_URL } = require('./DemandForecast');
const { gradeSnapshots } = require('../services/forecastAccuracy');
const { dayNumber, isoFromDay } = require('../services/forecastEngine');

const LIVE_WINDOW_DAYS = 120; // how far back saved forecasts are graded
const BACKTEST_TIMEOUT_MS = Number(process.env.PYTHON_AI_BACKTEST_TIMEOUT_MS) || 30000;
const BACKTEST_CACHE_MS = 5 * 60 * 1000;
const BACKTEST_URL = process.env.PYTHON_AI_BACKTEST_URL || PYTHON_AI_URL.replace(/\/forecast\/?$/, '/backtest');
const MS_PER_DAY = 86400000;

const isoDate = (d) => d.toISOString().slice(0, 10);

// Saved forecasts vs what really sold since. Grading a snapshot needs its whole horizon to be in the past.
const getLiveAccuracy = async (today) => {
  const cutoff = new Date(Date.parse(`${isoFromDay(dayNumber(today) - LIVE_WINDOW_DAYS)}T00:00:00Z`));
  // Only the engine version that is currently saving forecasts is graded, so a day is never counted twice
  // when a version change left two snapshots for the same date.
  const latest = await prisma.forecastSnapshot.findFirst({
    orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }],
    select: { model: true },
  });
  const rows = await prisma.forecastSnapshot.findMany({
    where: { asOf: { gte: cutoff }, ...(latest ? { model: latest.model } : {}) },
    include: { items: true },
    orderBy: { asOf: 'asc' },
  });
  const snapshots = rows.map((s) => ({
    asOf: isoDate(s.asOf),
    revenue7: Number(s.revenue7),
    revenue30: Number(s.revenue30),
    items: s.items.map((i) => ({ productId: i.productId, sku: i.sku, forecast7: i.forecast7 })),
  }));

  const first = await prisma.transaction.aggregate({ _min: { createdAt: true } });
  const storeStart = first._min.createdAt ? dayNumber(localDate(first._min.createdAt, STORE_TIMEZONE)) : null;

  let unitsByProduct = new Map();
  let grossByDay = new Map();
  if (snapshots.length && storeStart !== null) {
    // 30 days before the oldest snapshot are needed for the "previous period" baseline
    const since = new Date(Date.parse(`${snapshots[0].asOf}T00:00:00Z`) - 32 * MS_PER_DAY);
    const { salesRows, totalRows } = await loadDailySales({ since, timeZone: STORE_TIMEZONE });
    for (const r of salesRows) {
      if (!unitsByProduct.has(r.productId)) unitsByProduct.set(r.productId, new Map());
      unitsByProduct.get(r.productId).set(dayNumber(r.date), r.quantity);
    }
    grossByDay = new Map(totalRows.map((r) => [dayNumber(r.date), r.gross]));
  }

  const graded = gradeSnapshots({
    snapshots,
    unitsByProduct,
    grossByDay,
    lastCompleteDay: isoFromDay(dayNumber(today) - 1),
    storeStart,
  });
  graded.meta.model = latest ? latest.model : null;
  return graded;
};

// The AI service replays its own engine over your history. Cached briefly: it is the heavier call and
// the answer only changes when a new day of sales completes.
let backtestCache = null;
const getBacktest = async (today) => {
  if (backtestCache && backtestCache.key === today && Date.now() - backtestCache.at < BACKTEST_CACHE_MS) {
    return backtestCache.value;
  }
  try {
    const input = await loadForecastInput(30, today);
    const response = await postJson(BACKTEST_URL, input, { timeoutMs: BACKTEST_TIMEOUT_MS, retries: 0 });
    if (!response.data || !response.data.units7) throw new Error('unexpected response shape');
    const value = { available: true, ...response.data };
    backtestCache = { key: today, at: Date.now(), value };
    return value;
  } catch (error) {
    const detail = error.response ? `HTTP ${error.response.status}` : error.message;
    logger.warn(`[forecast] backtest unavailable (${detail}).`);
    return { available: false, reason: 'The AI service is not reachable, so the backtest cannot run right now.' };
  }
};

const getAccuracy = async () => {
  const today = localDate(new Date(), STORE_TIMEZONE);
  const [live, backtest] = await Promise.all([getLiveAccuracy(today), getBacktest(today)]);
  return { asOf: today, live, backtest };
};

module.exports = { getAccuracy, getLiveAccuracy, getBacktest };

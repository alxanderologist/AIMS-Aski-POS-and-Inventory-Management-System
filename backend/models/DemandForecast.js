const { prisma } = require('./Product');
const logger = require('../services/logger');
const { buildForecast } = require('../services/forecastEngine');
const { postJson, createBreaker } = require('../services/aiClient');
const { createCache } = require('../services/forecastCache');
const { loadDailySales } = require('./salesHistory');
const { loadStockoutDays } = require('./stockHistory');

const PYTHON_AI_URL = process.env.PYTHON_AI_URL || 'http://localhost:8000/api/v1/forecast';
const AI_TIMEOUT_MS = Number(process.env.PYTHON_AI_TIMEOUT_MS) || 5000;
const AI_RETRIES = 1;
// After 3 failed calls in a row the AI service is skipped for a minute instead of costing every request 10s.
const aiBreaker = createBreaker({ threshold: 3, cooldownMs: 60000 });
const CACHE_MS = (Number(process.env.FORECAST_CACHE_SECONDS) >= 0 ? Number(process.env.FORECAST_CACHE_SECONDS) : 300) * 1000;
const FALLBACK_CACHE_MS = Math.min(CACHE_MS, 30000); // retry the AI service soon
const forecastCache = createCache({ ttlMs: CACHE_MS });
const HISTORY_DAYS = Number(process.env.FORECAST_HISTORY_DAYS) || 180;
// Stock-out days are only needed for recent demand (a 28-day window, plus the backtest's replays), so
// only this many days back are sent; a product stuck at zero stock would otherwise add a row per day.
const STOCKOUT_LOOKBACK_DAYS = 90;
const DEFAULT_LEAD_TIME_DAYS = 7; // products without a supplier
const MIN_HORIZON_DAYS = 1;
const MAX_HORIZON_DAYS = 365;
const MS_PER_DAY = 86400000;

// Sales are bucketed into calendar days in the store's own time zone, not UTC, so a 7am sale in
// Manila counts toward that day's total instead of the previous one.
const resolveTimeZone = () => {
  const wanted = process.env.STORE_TIMEZONE || process.env.TZ || 'Asia/Manila';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: wanted });
    return wanted;
  } catch {
    return 'Asia/Manila';
  }
};
const STORE_TIMEZONE = resolveTimeZone();

const localDate = (instant, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);

const clampHorizon = (value) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 30;
  return Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, n));
};

// Everything the forecast needs, aggregated in SQL: one row per product per day, and one row per day.
const loadForecastInput = async (daysToForecast, asOf) => {
  const timeZone = STORE_TIMEZONE;
  // Coarse UTC lower bound (a couple of days of slack); the engine applies the exact window.
  const lowerBound = new Date(Date.parse(`${asOf}T00:00:00Z`) - (HISTORY_DAYS + 2) * MS_PER_DAY);

  const stockoutFrom = new Date(Date.parse(`${asOf}T00:00:00Z`) - (STOCKOUT_LOOKBACK_DAYS + 2) * MS_PER_DAY);
  const [products, { salesRows, totalRows }, stockoutsByProduct, pendingOrders] = await Promise.all([
    prisma.product.findMany({
      select: {
        id: true, sku: true, name: true, category: true, stock: true, minStock: true, expiryDate: true, createdAt: true,
        supplier: { select: { leadTimeDays: true } },
      },
      orderBy: { id: 'asc' },
    }),
    loadDailySales({ since: lowerBound, timeZone }),
    loadStockoutDays({
      since: stockoutFrom,
      timeZone,
      fromDay: localDate(stockoutFrom, timeZone),
      lastDay: new Date(Date.parse(`${asOf}T00:00:00Z`) - MS_PER_DAY).toISOString().slice(0, 10),
    }),
    // Units already ordered from suppliers but not yet received; draft orders are not commitments.
    prisma.purchaseOrderItem.groupBy({
      by: ['productId'],
      where: { purchaseOrder: { status: 'PENDING' } },
      _sum: { quantity: true },
    }),
  ]);
  const onOrderByProduct = new Map(pendingOrders.map((r) => [r.productId, r._sum.quantity || 0]));

  const skuById = new Map();
  const productInputs = products.map((p) => {
    const sku = p.sku || `PROD-${p.id}`;
    skuById.set(p.id, sku);
    return {
      id: p.id,
      sku,
      name: p.name,
      category: p.category,
      stock: p.stock,
      minStock: p.minStock,
      // Expiry is a calendar date (stored as UTC midnight); creation is a real instant in store time.
      expiryDate: p.expiryDate ? p.expiryDate.toISOString().slice(0, 10) : null,
      createdAt: localDate(p.createdAt, timeZone),
      leadTimeDays: p.supplier ? p.supplier.leadTimeDays : DEFAULT_LEAD_TIME_DAYS,
      onOrder: onOrderByProduct.get(p.id) || 0,
    };
  });

  return {
    asOf,
    timezone: timeZone,
    daysToForecast,
    historyDays: HISTORY_DAYS,
    products: productInputs,
    sales: salesRows
      .filter((r) => skuById.has(r.productId))
      .map((r) => ({ sku: skuById.get(r.productId), date: r.date, quantity: r.quantity, revenue: r.revenue })),
    dailyTotals: totalRows.map((r) => ({ date: r.date, gross: r.gross, discount: r.discount, net: r.net, simulated: r.simulated })),
    stockouts: [...stockoutsByProduct]
      .filter(([productId]) => skuById.has(productId))
      .flatMap(([productId, dates]) => dates.map((date) => ({ sku: skuById.get(productId), date }))),
  };
};

const looksLikeForecast = (data) =>
  data &&
  typeof data === 'object' &&
  data.kpis &&
  Array.isArray(data.revenueTrajectory) &&
  Array.isArray(data.skuDemandList) &&
  data.meta;

const computeForecast = async (daysToForecast, today) => {
  const input = await loadForecastInput(daysToForecast, today);

  try {
    const response = await postJson(PYTHON_AI_URL, input, { timeoutMs: AI_TIMEOUT_MS, retries: AI_RETRIES, breaker: aiBreaker });
    if (!looksLikeForecast(response.data)) throw new Error('AI service returned an unexpected response shape');
    return response.data;
  } catch (error) {
    let detail = error.message;
    if (error.response) {
      detail = `HTTP ${error.response.status} ${JSON.stringify(error.response.data).slice(0, 300)}`;
      if (error.response.status === 401) detail += ' - check that AI_SERVICE_KEY matches in backend/.env and ai-service/.env';
    }
    logger.warn(`[forecast] AI service unavailable (${detail}). Using the built-in engine (same method, source: "fallback").`);
    const result = buildForecast(input, { source: 'fallback' });
    result.meta.generatedAt = new Date().toISOString();
    return result;
  }
};

// When no explicit `asOf` is given, "today" defaults to the day after the most recent real sale
// instead of the server clock: a data backfill (e.g. importing May-July history with no August/September
// sales yet recorded) would otherwise leave a gap of pure zero-sales days right before the real clock
// date, which zeros out every product's demand rate. This is self-correcting — once live sales catch up
// to the real calendar date, this naturally returns the real date instead of trailing behind it forever.
const resolveDefaultAsOf = async () => {
  const real = localDate(new Date(), STORE_TIMEZONE);
  const latest = await prisma.transaction.aggregate({ _max: { createdAt: true } });
  if (!latest._max.createdAt) return real;
  const dayAfterLastSale = new Date(`${localDate(latest._max.createdAt, STORE_TIMEZONE)}T00:00:00Z`);
  dayAfterLastSale.setUTCDate(dayAfterLastSale.getUTCDate() + 1);
  const candidate = dayAfterLastSale.toISOString().slice(0, 10);
  return candidate < real ? candidate : real;
};

// `asOf` (YYYY-MM-DD, store-local "today") is injectable so a given day's forecast can be reproduced.
// Results are cached for a few minutes (cleared by any successful write request, see index.js); `refresh`
// skips the cache. `meta.cached` says whether this response came from it.
const getForecastData = async (days = 30, { asOf, refresh = false } = {}) => {
  const daysToForecast = clampHorizon(days);
  const today = asOf || (await resolveDefaultAsOf());
  if (refresh) forecastCache.invalidate();
  const { value, cached } = await forecastCache.get(`${today}|${daysToForecast}`, () => computeForecast(daysToForecast, today), {
    ttlFor: (result) => (result.meta && result.meta.source === 'fallback' ? FALLBACK_CACHE_MS : CACHE_MS),
  });
  return { ...value, meta: { ...value.meta, cached } };
};

const invalidateForecastCache = () => forecastCache.invalidate();

module.exports = { getForecastData, loadForecastInput, invalidateForecastCache, STORE_TIMEZONE, HISTORY_DAYS, PYTHON_AI_URL, localDate };

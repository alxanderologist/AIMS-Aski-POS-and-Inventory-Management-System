// Saves each day's forecast so it can later be graded against what actually sold (see
// models/ForecastAccuracy.js). One snapshot per store-local day per engine version; saving is
// idempotent, so the nightly cron and the "first dashboard request of the day" hook can both run.
const { prisma } = require('../models/Product');
const logger = require('./logger');
const { getForecastData, STORE_TIMEZONE, localDate } = require('../models/DemandForecast');

const MIN_FORECAST_DAYS = 30; // revenue30 needs a 30-day path

const round2 = (x) => Math.round(x * 100) / 100 + 0;

// Turns a forecast response into the rows to store, or null when there is nothing worth grading.
const buildSnapshot = (data) => {
  if (!data || !data.meta || !Array.isArray(data.revenueTrajectory) || !Array.isArray(data.skuDemandList)) return null;
  const future = data.revenueTrajectory
    .filter((p) => p.actual == null && p.forecast != null)
    .map((p) => Number(p.forecast));
  if (data.meta.observedDays <= 0 || future.length < MIN_FORECAST_DAYS) return null;

  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  return {
    asOf: data.meta.asOf,
    model: `${data.meta.engine}@${data.meta.engineVersion}`,
    source: data.meta.source || 'unknown',
    revenue7: round2(sum(future.slice(0, 7))),
    revenue30: round2(sum(future.slice(0, 30))),
    items: data.skuDemandList
      .filter((i) => i.dataDays > 0) // products with no history at that point have nothing to grade
      .map((i) => ({ productId: i.id, sku: i.sku, forecast7: i.forecast7Day, confidence: i.confidence })),
  };
};

// Only today's forecast may be saved: a snapshot has to be what the system really said that day.
// (`allowPast` exists for tests; replaying history is the backtest's job.)
const saveSnapshot = async (data, { allowPast = false } = {}) => {
  const snap = buildSnapshot(data);
  if (!snap) return { saved: false, reason: 'nothing-to-grade' };
  if (!allowPast && snap.asOf !== localDate(new Date(), STORE_TIMEZONE)) return { saved: false, reason: 'not-today' };

  try {
    const created = await prisma.forecastSnapshot.create({
      data: {
        asOf: new Date(`${snap.asOf}T00:00:00Z`),
        model: snap.model,
        source: snap.source,
        revenue7: snap.revenue7,
        revenue30: snap.revenue30,
        items: { create: snap.items },
      },
    });
    return { saved: true, id: created.id, asOf: snap.asOf, items: snap.items.length };
  } catch (error) {
    if (error && error.code === 'P2002') return { saved: false, reason: 'already-saved', asOf: snap.asOf };
    throw error;
  }
};

// Called from the forecast route: cheap after the first call of the day, never blocks or fails a request.
const savedToday = new Set();
const saveFromRequest = (data) => {
  const key = data && data.meta ? `${data.meta.asOf}|${data.meta.engine}@${data.meta.engineVersion}` : null;
  if (!key || savedToday.has(key)) return;
  saveSnapshot(data)
    .then((result) => {
      if (result.saved || result.reason === 'already-saved') savedToday.add(key);
      if (result.saved) logger.info(`[forecast] saved snapshot for ${result.asOf} (${result.items} products)`);
    })
    .catch((error) => logger.error({ err: error }, '[forecast] could not save snapshot'));
};

// Nightly job: forecast for the day that just began, from the complete previous day.
const saveToday = async () => saveSnapshot(await getForecastData(MIN_FORECAST_DAYS));

module.exports = { buildSnapshot, saveSnapshot, saveFromRequest, saveToday };

// Daily AI Demand Forecast digest.
// Fetches the current forecast (Python service if up, else the JS fallback)
// and emails a compact summary: KPIs + top high-risk SKUs + 7-day revenue
// look-back and look-ahead.

const { getForecastData } = require('../models/DemandForecast');
const logger = require('./logger');
const mailer = require('./mailer');

async function buildDigest(days = 30) {
  const forecast = await getForecastData(days);
  if (!forecast) return null;

  const kpis = forecast.kpis || {};
  const trajectory = Array.isArray(forecast.revenueTrajectory) ? forecast.revenueTrajectory : [];
  const skus = Array.isArray(forecast.skuDemandList) ? forecast.skuDemandList : [];

  const actual = trajectory.filter((d) => d.actual != null);
  // The first forecast point repeats the last actual so the chart lines join; only count future days.
  const forecastPts = trajectory.filter((d) => d.actual == null && d.forecast != null);
  const sumActual = actual.reduce((a, d) => a + Number(d.actual || 0), 0);
  const sumForecast = forecastPts.reduce((a, d) => a + Number(d.forecast || 0), 0);

  const highRisk = skus.filter((s) => s.status && s.status !== 'HEALTHY');

  return { kpis, trajectory, skus, highRisk, sumActual, sumForecast, meta: forecast.meta };
}

async function sendDigestNow(days = 30) {
  const digest = await buildDigest(days);
  if (!digest) return { skipped: true, reason: 'no forecast data' };

  const res = await mailer.sendForecastDigest(digest);
  if (res && res.messageId) {
    logger.info(`[forecast] sent digest — ${res.messageId}`);
  }
  return { ok: true, ...res };
}

module.exports = { buildDigest, sendDigestNow };

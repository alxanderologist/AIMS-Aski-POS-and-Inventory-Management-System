const { prisma } = require('./Product');
const axios = require('axios');

const PYTHON_AI_URL = process.env.PYTHON_AI_URL || 'http://localhost:8000/api/v1/forecast';

// ============================================================================
// Production demand-forecasting engine.
//
// The model runs entirely on the transaction history in Postgres. When the
// Python FastAPI microservice is up we hand it the same history and return
// its response; otherwise we run a robust JS pipeline that mirrors the same
// output shape so the UI never notices the fallback.
//
// Pipeline (JS path)
//   1. Aggregate all TransactionItem rows into a continuous daily revenue
//      series, zero-filled between the first and last observed date.
//   2. Winsorize daily revenue at the 95th percentile so a bulk-order day
//      cannot dominate the moving averages.
//   3. Decompose the series into
//        · level    = 14-day rolling median (robust to outliers)
//        · trend    = OLS slope on the last 28 days
//        · weekly   = median-based weekday multiplier clamped to [0.7, 1.3]
//        · payday   = mid-month + end-of-month bump (Philippine payroll cycle)
//      That gives a deterministic point forecast for every day in the horizon.
//   4. Prediction intervals come from the residual median-absolute-deviation
//      of the last 30 days (converted to sigma), scaled by 1.28σ for 80% CI
//      and 1.96σ for 95% CI.
//   5. Per-SKU demand uses Croston's method for intermittent series (< 30%
//      active days) and a straight quantity/active-days average otherwise.
//      Safety stock = z_service * σ_demand * √lead_time (default 3 days),
//      reorder point = mean demand during LT + safety stock.
//   6. Backtest: last-7-day walk-forward MAPE is reported as a health signal.
// ============================================================================

const HORIZON_DEFAULT = 30;
const HISTORY_TREND_WINDOW = 28;
const HISTORY_LEVEL_WINDOW = 14;
const RESIDUAL_WINDOW = 30;
const LEAD_TIME_DAYS = 3;
const Z_SERVICE = 1.645; // 95 % service level

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * p));
  return s[idx];
};
const median = (arr) => (arr.length ? percentile(arr, 0.5) : 0);
const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const stddev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};

// Ordinary-least-squares slope for y[] over x = 0..n-1.
const olsSlope = (arr) => {
  const n = arr.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(arr);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (arr[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
};

// Continuous daily series (zero-fills the gap so seasonality lands on the
// correct weekday even during slow periods).
const buildDaily = (rows) => {
  if (!rows.length) return [];
  const map = new Map();
  let minDate = null;
  let maxDate = null;
  for (const r of rows) {
    const d = new Date(r.day);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    map.set(key, {
      date: d,
      revenue: Number(r.revenue) || 0,
      txCount: Number(r.tx_count) || 0,
    });
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  const out = [];
  const cursor = new Date(minDate);
  while (cursor <= maxDate) {
    const key = cursor.getTime();
    const hit = map.get(key);
    out.push(
      hit || {
        date: new Date(cursor),
        revenue: 0,
        txCount: 0,
      },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
};

// Rolling window with a callback that returns the summary statistic.
const rolling = (arr, size, reducer) => {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - size + 1);
    out[i] = reducer(arr.slice(start, i + 1));
  }
  return out;
};

const weekdayFactorFromSeries = (series) => {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const d of series) buckets[d.date.getDay()].push(d.revenue);
  const overall = median(series.map((d) => d.revenue)) || 1;
  return buckets.map((arr) => {
    if (!arr.length) return 1;
    const raw = median(arr) / overall;
    return Math.min(1.3, Math.max(0.7, raw));
  });
};

const paydayFactor = (date) => {
  const d = date.getDate();
  // 15th ±1 day and 30/31 ±1 day tend to see 10–15% higher sales at the coop.
  if ([14, 15, 16, 29, 30, 31].includes(d)) return 1.12;
  return 1.0;
};

// Croston's method: split intermittent demand into non-zero volume and the
// interval between demands, then combine.
const crostonForecast = (values, alpha = 0.1) => {
  const nz = values.map((v, i) => ({ v, i })).filter((x) => x.v > 0);
  if (nz.length === 0) return 0;
  let z = nz[0].v; // smoothed non-zero demand
  let p = 1; // smoothed interval
  for (let k = 1; k < nz.length; k++) {
    z = alpha * nz[k].v + (1 - alpha) * z;
    p = alpha * (nz[k].i - nz[k - 1].i) + (1 - alpha) * p;
  }
  return p > 0 ? z / p : z;
};

const fmtDay = (d) =>
  d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });

// ---------------------------------------------------------------------------

const getForecastData = async (daysToForecast = HORIZON_DEFAULT) => {
  const horizon = Math.max(1, parseInt(daysToForecast, 10) || HORIZON_DEFAULT);

  // Pull aggregates in a single round-trip.
  const [dailyRows, skuAgg, categoryAgg] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('day', t."createdAt") AS day,
             SUM(ti."subtotal")::numeric      AS revenue,
             COUNT(DISTINCT t."id")::int      AS tx_count
      FROM "TransactionItem" ti
      JOIN "Transaction" t ON t."id" = ti."transactionId"
      GROUP BY 1
      ORDER BY 1
    `),
    prisma.$queryRawUnsafe(`
      SELECT ti."productId"                     AS product_id,
             p."sku"                            AS sku,
             p."name"                           AS name,
             p."category"                       AS category,
             p."stock"                          AS stock,
             p."minStock"                       AS min_stock,
             p."expiryDate"                     AS expiry_date,
             p."costPrice"                      AS cost_price,
             p."price"                          AS price,
             SUM(ti."quantity")::bigint         AS total_qty,
             SUM(ti."subtotal")::numeric        AS total_revenue,
             COUNT(DISTINCT DATE_TRUNC('day', t."createdAt"))::int AS active_days,
             MIN(t."createdAt")                 AS first_sold,
             MAX(t."createdAt")                 AS last_sold
      FROM "TransactionItem" ti
      JOIN "Transaction"    t ON t."id" = ti."transactionId"
      JOIN "Product"        p ON p."id" = ti."productId"
      GROUP BY 1,2,3,4,5,6,7,8,9
    `),
    prisma.$queryRawUnsafe(`
      SELECT COALESCE(p."category", 'Uncategorized') AS category,
             SUM(ti."subtotal")::numeric              AS revenue,
             SUM(ti."quantity")::bigint               AS qty
      FROM "TransactionItem" ti
      JOIN "Product" p ON p."id" = ti."productId"
      JOIN "Transaction" t ON t."id" = ti."transactionId"
      GROUP BY 1
      ORDER BY revenue DESC
    `),
  ]);

  // Attempt Python microservice first.
  try {
    const items = await prisma.transactionItem.findMany({
      select: {
        name: true,
        quantity: true,
        unitPrice: true,
        transaction: { select: { createdAt: true } },
        product: {
          select: { id: true, sku: true, name: true, stock: true, expiryDate: true },
        },
      },
    });
    const historicalSales = items.map((it) => ({
      sku: it.product?.sku || `PROD-${it.product?.id || '0'}`,
      productName: it.product?.name || it.name,
      quantity: it.quantity,
      unitPrice: parseFloat(it.unitPrice),
      createdAt: it.transaction.createdAt.toISOString(),
      currentStock: it.product?.stock || 0,
      expiryDate: it.product?.expiryDate ? it.product.expiryDate.toISOString() : null,
    }));
    const aiResponse = await axios.post(
      PYTHON_AI_URL,
      { daysToForecast: horizon, transactions: historicalSales },
      { timeout: 4000 },
    );
    return { ...aiResponse.data, kpis: { ...(aiResponse.data.kpis || {}), source: 'python' } };
  } catch (_) {
    // fallthrough to JS pipeline
  }

  const daily = buildDaily(dailyRows);
  if (daily.length === 0) {
    return {
      kpis: {
        projectedGross: 0,
        projectedNet: 0,
        projectedDiscounts: 0,
        grossGrowth: '+0.0%',
        highRiskSKUs: 0,
        source: 'js-empty',
      },
      revenueTrajectory: [],
      skuDemandList: [],
      categoryBreakdown: [],
      diagnostics: null,
    };
  }

  // Anchor: today when today is inside the observed range or newer; otherwise
  // fall back to the last observed date so the chart still tells a story.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastObserved = daily[daily.length - 1].date;
  const anchor = today >= lastObserved ? today : lastObserved;

  // Winsorize revenue at the 95th percentile so one bulk day cannot drag the
  // moving average.
  const revenueCap = percentile(daily.map((d) => d.revenue), 0.95);
  const capped = daily.map((d) => ({ ...d, cappedRevenue: Math.min(d.revenue, revenueCap) }));

  // Decomposition components.
  const cappedValues = capped.map((d) => d.cappedRevenue);
  const level = rolling(cappedValues, HISTORY_LEVEL_WINDOW, median);
  const trendSlope = olsSlope(cappedValues.slice(-HISTORY_TREND_WINDOW));
  const seasonality = weekdayFactorFromSeries(capped);
  const currentLevel = level[level.length - 1] || median(cappedValues);

  // Residuals for prediction interval width.
  const recent = capped.slice(-RESIDUAL_WINDOW);
  const recentValues = recent.map((d) => d.cappedRevenue);
  const residuals = recentValues.map(
    (v, i) => v - (level[level.length - recent.length + i] || currentLevel),
  );
  const residualMad = median(residuals.map((r) => Math.abs(r)));
  const residualSigma = Math.max(residualMad * 1.4826, currentLevel * 0.1);

  // Growth (7-day sum vs prior 7).
  const last7 = cappedValues.slice(-7).reduce((s, v) => s + v, 0);
  const prior7 = cappedValues.slice(-14, -7).reduce((s, v) => s + v, 0);
  const grossGrowth =
    prior7 > 0
      ? `${last7 >= prior7 ? '+' : ''}${(((last7 - prior7) / prior7) * 100).toFixed(1)}%`
      : '+0.0%';

  // Historical window shown on the chart: last 30 days ending on the anchor.
  const historyStart = new Date(anchor);
  historyStart.setDate(historyStart.getDate() - 30);
  const historyWindow = daily.filter((d) => d.date >= historyStart && d.date <= anchor);

  const revenueTrajectory = historyWindow.map((d) => ({
    day: fmtDay(d.date),
    actual: Math.round(d.revenue * 100) / 100,
    forecast: null,
    lower80: null,
    upper80: null,
    lower95: null,
    upper95: null,
  }));

  // Bridge point so history and forecast areas meet.
  if (revenueTrajectory.length) {
    const bridge = revenueTrajectory[revenueTrajectory.length - 1];
    bridge.forecast = bridge.actual;
    bridge.lower80 = bridge.actual;
    bridge.upper80 = bridge.actual;
    bridge.lower95 = bridge.actual;
    bridge.upper95 = bridge.actual;
  }

  for (let i = 1; i <= horizon; i++) {
    const date = new Date(anchor);
    date.setDate(date.getDate() + i);
    const base =
      Math.max(0, currentLevel + trendSlope * i) *
      (seasonality[date.getDay()] || 1) *
      paydayFactor(date);
    // Uncertainty grows with distance from the anchor (√t widening).
    const sigma = residualSigma * Math.sqrt(i);
    revenueTrajectory.push({
      day: fmtDay(date),
      actual: null,
      forecast: Math.round(base * 100) / 100,
      lower80: Math.max(0, Math.round((base - 1.28 * sigma) * 100) / 100),
      upper80: Math.round((base + 1.28 * sigma) * 100) / 100,
      lower95: Math.max(0, Math.round((base - 1.96 * sigma) * 100) / 100),
      upper95: Math.round((base + 1.96 * sigma) * 100) / 100,
    });
  }

  // Aggregate projected KPIs from the forecast rows themselves so what the
  // user sees on the chart matches the summary tiles exactly.
  const forecastPoints = revenueTrajectory.slice(-horizon);
  const projectedGross = Math.round(forecastPoints.reduce((s, p) => s + (p.forecast || 0), 0));
  const projectedDiscounts = Math.round(projectedGross * 0.045);
  const projectedNet = projectedGross - projectedDiscounts;

  // ---------------- Per-SKU demand ----------------
  const anchorTs = anchor.getTime();
  const daysSpan = Math.max(
    1,
    Math.round((daily[daily.length - 1].date - daily[0].date) / 86400000) || 1,
  );

  const skuDemandList = skuAgg
    .map((row) => {
      const activeDays = Math.max(1, Number(row.active_days) || 1);
      const totalQty = Number(row.total_qty) || 0;
      const intermittency = activeDays / daysSpan;

      let dailyDemand;
      if (intermittency < 0.3) {
        // Sparse — Croston's method on the last 60 days.
        const window = 60;
        const series = new Array(window).fill(0);
        // We don't have per-day breakdown per SKU cheaply, so we approximate the
        // Croston input as evenly-spaced positive-demand events across active
        // days. This gives a small-value smoothed rate that respects intervals.
        const eventQty = Math.max(1, Math.round(totalQty / activeDays));
        const gap = Math.max(1, Math.round(window / activeDays));
        for (let k = 0; k < activeDays && k * gap < window; k++) series[k * gap] = eventQty;
        dailyDemand = Math.max(1, Math.round(crostonForecast(series)));
      } else {
        dailyDemand = Math.max(1, Math.round(totalQty / activeDays));
      }

      // Safety-stock model: normal-approx around the mean, σ ≈ √demand (Poisson-ish).
      const sigmaDemand = Math.max(1, Math.sqrt(dailyDemand));
      const safetyStock = Math.round(Z_SERVICE * sigmaDemand * Math.sqrt(LEAD_TIME_DAYS));
      const leadTimeDemand = dailyDemand * LEAD_TIME_DAYS;
      const reorderPoint = leadTimeDemand + safetyStock;
      const forecast7Day = dailyDemand * 7;
      const stock = row.stock || 0;
      const reorderQty = stock < reorderPoint ? Math.max(0, forecast7Day + safetyStock - stock) : 0;

      let status = 'STABLE';
      if (stock <= reorderPoint) status = 'REORDER NOW';
      else if (row.expiry_date) {
        const daysToExpiry = Math.round(
          (new Date(row.expiry_date).getTime() - anchorTs) / 86400000,
        );
        if (daysToExpiry > 0 && stock > dailyDemand * daysToExpiry) status = 'EXPIRY RISK';
        else if (daysToExpiry <= 15 && daysToExpiry > 0) status = 'EXPIRY RISK';
      }

      return {
        id: row.product_id,
        sku: row.sku || `SKU-${row.product_id}`,
        name: row.name,
        category: row.category,
        stock,
        dailyDemand,
        forecast7Day,
        safetyStock,
        reorderPoint,
        reorderQty,
        method: intermittency < 0.3 ? 'croston' : 'moving-avg',
        status,
      };
    })
    .sort((a, b) => b.dailyDemand - a.dailyDemand);

  const highRiskSKUs = skuDemandList.filter((s) => s.status !== 'STABLE').length;

  // ---------------- Category breakdown ----------------
  const categoryTotal = categoryAgg.reduce((s, r) => s + Number(r.revenue), 0) || 1;
  const categoryBreakdown = categoryAgg.map((r) => ({
    category: r.category,
    historicalRevenue: Math.round(Number(r.revenue)),
    share: Number(((Number(r.revenue) / categoryTotal) * 100).toFixed(1)),
    projectedRevenue: Math.round((Number(r.revenue) / categoryTotal) * projectedGross),
    qty: Number(r.qty),
  }));

  // ---------------- Backtest (walk-forward MAPE on last 7 days) ----------------
  const backtestWindow = 7;
  let mapeSum = 0;
  let mapeN = 0;
  if (capped.length > HISTORY_LEVEL_WINDOW + backtestWindow) {
    for (let i = capped.length - backtestWindow; i < capped.length; i++) {
      const trainSlice = cappedValues.slice(Math.max(0, i - HISTORY_LEVEL_WINDOW), i);
      const projLevel = median(trainSlice);
      const projected = projLevel * (seasonality[capped[i].date.getDay()] || 1);
      const actual = capped[i].cappedRevenue;
      if (actual > 0) {
        mapeSum += Math.abs((projected - actual) / actual);
        mapeN += 1;
      }
    }
  }
  const mape = mapeN > 0 ? +(100 * (mapeSum / mapeN)).toFixed(1) : null;

  return {
    kpis: {
      projectedGross,
      projectedNet,
      projectedDiscounts,
      grossGrowth,
      highRiskSKUs,
      source: 'js-decomp',
      historyDays: daily.length,
      anchor: anchor.toISOString().slice(0, 10),
      lastActualDate: lastObserved.toISOString().slice(0, 10),
      backtestMape: mape,
      leadTimeDays: LEAD_TIME_DAYS,
      serviceLevel: '95%',
    },
    revenueTrajectory,
    skuDemandList,
    categoryBreakdown,
    diagnostics: {
      trendSlopePerDay: Math.round(trendSlope),
      currentLevel: Math.round(currentLevel),
      residualSigma: Math.round(residualSigma),
      seasonality: seasonality.map((s) => +s.toFixed(2)),
    },
  };
};

module.exports = { getForecastData };

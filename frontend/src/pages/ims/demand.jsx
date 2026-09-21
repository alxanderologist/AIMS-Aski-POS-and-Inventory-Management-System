import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
  TrendingUp,
  AlertTriangle,
  PackageCheck,
  DollarSign,
  RefreshCw,
  Calendar,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend
} from 'recharts';

export default function Demand() {
  const [demandMode, setDemandMode] = useState('current'); // 'current' (30 days) | 'future' (60 days)
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetchForecast = async () => {
    setLoading(true);
    setError(null);
    try {
      const days = demandMode === 'future' ? 60 : 30;
      // Fetching predictions from Express backend endpoint
      const res = await axios.get(`http://localhost:5000/api/forecast?days=${days}`);

      if (res.data.success) {
        setForecast(res.data.data);
      } else {
        setError('Failed to load forecast data from server');
      }
    } catch (err) {
      console.error('Error fetching AI predictions:', err);
      setError('Cannot connect to AI service. Ensure backend and FastAPI are running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchForecast();
  }, [demandMode]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-600 font-bold text-sm">
          <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
          <span>Generating AI Demand & Revenue Predictions...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="bg-gradient-to-br from-white via-white/90 to-blue-200/60 backdrop-blur-xl border border-white/80 p-6 rounded-3xl shadow-xl shadow-blue-500/10 max-w-md text-center">
          <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
          <p className="text-rose-600 font-bold text-sm mb-2">{error}</p>
          <button
            onClick={fetchForecast}
            className="px-4 py-2 bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold text-xs rounded-full shadow-md hover:shadow-lg hover:shadow-blue-500/30 transition-all cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const { kpis, revenueTrajectory, skuDemandList, categoryBreakdown = [], diagnostics = null } = forecast;

  // Recharts needs a positive width for the band Area — carry it as `bandRange`
  // so we can render an [lower95, upper95] area behind the point forecast.
  const trajectoryWithBand = revenueTrajectory.map((p) => ({
    ...p,
    band95: p.upper95 != null && p.lower95 != null ? [p.lower95, p.upper95] : null,
    band80: p.upper80 != null && p.lower80 != null ? [p.lower80, p.upper80] : null,
  }));

  const pesos = (n) => `₱${Number(n || 0).toLocaleString()}`;

  return (
    <div className="space-y-6">
      {/* ===== HEADER ====== */}
      <header className="relative z-30 flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-white via-white/90 to-blue-200/60 backdrop-blur-xl border border-white/80 rounded-3xl px-8 py-4 shadow-xl shadow-blue-500/10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/30">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-blue-600">AMPC</p>
            <h2 className="text-2xl font-black text-slate-800 tracking-tight">DEMAND & SALES FORECASTING</h2>
          </div>
        </div>

        {/* Forecast window toggle */}
        <div className="flex items-center gap-2 bg-white/60 backdrop-blur-sm p-1.5 rounded-2xl border border-white/70">
          <button
            onClick={() => setDemandMode('current')}
            className={`flex items-center gap-2 px-4 py-2 font-bold text-xs rounded-xl transition-all cursor-pointer ${
              demandMode === 'current'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Calendar className="w-4 h-4" />
            <span>30-Day Outlook</span>
          </button>
          <button
            onClick={() => setDemandMode('future')}
            className={`flex items-center gap-2 px-4 py-2 font-bold text-xs rounded-xl transition-all cursor-pointer ${
              demandMode === 'future'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            <span>60-Day Forecast</span>
          </button>
        </div>
      </header>

      {/* SUMMARY KPI CARDS — same glass-gradient card treatment as finance.jsx's 3 core KPI cards */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {/* Gross Projected Revenue */}
        <div className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-white/80 via-blue-100/30 to-indigo-300/40 backdrop-blur-xl border border-white/80 p-6 shadow-xl shadow-blue-500/10 hover:shadow-2xl hover:scale-[1.02] transition-all duration-300">
          <div className="flex items-center justify-between mb-3 relative z-10">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              Projected Gross
            </span>
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/30">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <h3 className="text-3xl font-black text-slate-800 tracking-tight mb-2 relative z-10">
            ₱{kpis.projectedGross?.toLocaleString() || '0'}
          </h3>
          <div className="flex items-center gap-2 text-xs relative z-10">
            <span className="inline-flex items-center font-bold px-2.5 py-1 rounded-xl bg-white/70 backdrop-blur-md shadow-sm text-emerald-600">
              <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
              {kpis.grossGrowth}
            </span>
            <span className="text-slate-500 font-medium">target trajectory</span>
          </div>
        </div>

        {/* Net Projected Revenue */}
        <div className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-white/80 via-blue-100/30 to-indigo-300/40 backdrop-blur-xl border border-white/80 p-6 shadow-xl shadow-blue-500/10 hover:shadow-2xl hover:scale-[1.02] transition-all duration-300">
          <div className="flex items-center justify-between mb-3 relative z-10">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              Projected Net
            </span>
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 text-white shadow-md shadow-blue-500/30">
              <TrendingUp className="w-5 h-5" />
            </div>
          </div>
          <h3 className="text-3xl font-black text-slate-800 tracking-tight mb-2 relative z-10">
            ₱{kpis.projectedNet?.toLocaleString() || '0'}
          </h3>
          <div className="flex items-center gap-2 text-xs relative z-10">
            <span className="text-slate-500 font-medium">After estimated discounts</span>
          </div>
        </div>

        {/* Discount Baseline */}
        <div className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-white/80 via-blue-100/30 to-indigo-300/40 backdrop-blur-xl border border-white/80 p-6 shadow-xl shadow-blue-500/10 hover:shadow-2xl hover:scale-[1.02] transition-all duration-300">
          <div className="flex items-center justify-between mb-3 relative z-10">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              Est. Discounts
            </span>
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-600 text-white shadow-md shadow-blue-500/30">
              <PackageCheck className="w-5 h-5" />
            </div>
          </div>
          <h3 className="text-3xl font-black text-slate-800 tracking-tight mb-2 relative z-10">
            ₱{kpis.projectedDiscounts?.toLocaleString() || '0'}
          </h3>
          <div className="flex items-center gap-2 text-xs relative z-10">
            <span className="inline-flex items-center font-bold px-2.5 py-1 rounded-xl bg-white/70 backdrop-blur-md shadow-sm text-amber-600">
              <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
              ~4.5%
            </span>
            <span className="text-slate-500 font-medium">promotional margin</span>
          </div>
        </div>

        {/* Stock Alerts */}
        <div className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-white/80 via-blue-100/30 to-indigo-300/40 backdrop-blur-xl border border-white/80 p-6 shadow-xl shadow-blue-500/10 hover:shadow-2xl hover:scale-[1.02] transition-all duration-300">
          <div className="flex items-center justify-between mb-3 relative z-10">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              Stock Alerts
            </span>
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-rose-600 to-pink-600 text-white shadow-md shadow-blue-500/30">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>
          <h3 className="text-3xl font-black text-slate-800 tracking-tight mb-2 relative z-10">
            {kpis.highRiskSKUs} Items
          </h3>
          <div className="flex items-center gap-2 text-xs relative z-10">
            <span className={`inline-flex items-center font-bold px-2.5 py-1 rounded-xl bg-white/70 backdrop-blur-md shadow-sm ${kpis.highRiskSKUs === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {kpis.highRiskSKUs === 0 ? <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" /> : <ArrowDownRight className="w-3.5 h-3.5 mr-0.5" />}
              {kpis.highRiskSKUs === 0 ? 'All Clear' : `${kpis.highRiskSKUs} Flagged`}
            </span>
            <span className="text-slate-500 font-medium">reorder or action</span>
          </div>
        </div>
      </div>

      {/* REVENUE TRAJECTORY GRAPH */}
      <div className="relative overflow-hidden bg-white border border-slate-200/80 rounded-3xl shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-sm shadow-blue-500/30">
            <TrendingUp className="w-4 h-4 text-white" />
          </div>
          <div>
            <h2 className="text-xs font-black text-slate-800 uppercase tracking-wide">Sales & Revenue Trajectory</h2>
            <p className="text-[11px] text-slate-500">Historical actual daily total vs AI projected trajectory</p>
          </div>
        </div>

        <div className="p-6">
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trajectoryWithBand} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorActual" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={(val) => `₱${Math.round(val).toLocaleString()}`} />
                <Tooltip formatter={(value, name) => [value == null ? '—' : pesos(value), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {/* 95 % confidence band */}
                <Area type="monotone" dataKey="band95" stroke="none" fill="#10b981" fillOpacity={0.08} name="95% Confidence" isAnimationActive={false} />
                {/* 80 % confidence band (inner, slightly darker) */}
                <Area type="monotone" dataKey="band80" stroke="none" fill="#10b981" fillOpacity={0.18} name="80% Confidence" isAnimationActive={false} />
                {/* Actual sales area */}
                <Area type="monotone" dataKey="actual" stroke="#4f46e5" fillOpacity={1} fill="url(#colorActual)" name="Actual Sales" />
                {/* Point forecast line */}
                <Line type="monotone" dataKey="forecast" stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" dot={false} name="AI Forecast" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {diagnostics && (
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-medium text-slate-500">
              <span>Anchor: <span className="text-slate-700 font-bold">{kpis.anchor}</span></span>
              <span>Last actual: <span className="text-slate-700 font-bold">{kpis.lastActualDate}</span></span>
              <span>History: <span className="text-slate-700 font-bold">{kpis.historyDays} days</span></span>
              <span>Backtest MAPE: <span className="text-slate-700 font-bold">{kpis.backtestMape != null ? kpis.backtestMape + '%' : 'n/a'}</span></span>
              <span>Trend: <span className="text-slate-700 font-bold">{diagnostics.trendSlopePerDay >= 0 ? '+' : ''}{pesos(diagnostics.trendSlopePerDay)}/day</span></span>
              <span>Level: <span className="text-slate-700 font-bold">{pesos(diagnostics.currentLevel)}</span></span>
              <span>Model: <span className="text-slate-700 font-bold">{kpis.source}</span></span>
              <span>Service level: <span className="text-slate-700 font-bold">{kpis.serviceLevel}</span></span>
              <span>Lead time: <span className="text-slate-700 font-bold">{kpis.leadTimeDays}d</span></span>
            </div>
          )}
        </div>
      </div>

      {/* CATEGORY BREAKDOWN */}
      {categoryBreakdown.length > 0 && (
        <div className="relative overflow-hidden bg-white border border-slate-200/80 rounded-3xl shadow-sm">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm shadow-emerald-500/30">
              <PackageCheck className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-xs font-black text-slate-800 uppercase tracking-wide">Projected Revenue by Category</h2>
              <p className="text-[11px] text-slate-500">Share allocated by historical revenue, scaled to the horizon projection</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-slate-700 bg-slate-50/80 border-b-2 border-slate-200 uppercase text-[11px] tracking-wider font-extrabold">
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Historical Revenue</th>
                  <th className="px-4 py-3 text-right">Qty Sold</th>
                  <th className="px-4 py-3 text-right">Share</th>
                  <th className="px-4 py-3 text-right">Projected Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {categoryBreakdown.slice(0, 20).map((c, idx) => (
                  <tr key={c.category} className={idx % 2 === 1 ? 'bg-slate-50/40' : ''}>
                    <td className="px-4 py-3 font-bold text-slate-900">{c.category}</td>
                    <td className="px-4 py-3 text-right">{pesos(c.historicalRevenue)}</td>
                    <td className="px-4 py-3 text-right">{Number(c.qty).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{c.share}%</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-600">{pesos(c.projectedRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SKU DEMAND & REORDER TABLE */}
      <div className="relative overflow-hidden bg-white border border-slate-200/80 rounded-3xl shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-sm shadow-blue-500/30">
              <PackageCheck className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-xs font-black text-slate-800 uppercase tracking-wide">SKU Demand & Reorder Logic</h2>
              <p className="text-[11px] text-slate-500">Item velocity, predicted 7-day demand, and suggested purchase order quantities</p>
            </div>
          </div>
          <span className="text-[11px] text-blue-700 font-bold bg-blue-500/10 border border-blue-200/50 px-2.5 py-1 rounded-full">{skuDemandList.length} items</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-slate-700 bg-slate-50/80 border-b-2 border-slate-200 uppercase text-[11px] tracking-wider font-extrabold">
                <th className="px-4 py-3.5">SKU</th>
                <th className="px-4 py-3.5">Product Name</th>
                <th className="px-4 py-3.5 text-center">Stock</th>
                <th className="px-4 py-3.5 text-center">Daily Demand</th>
                <th className="px-4 py-3.5 text-center">7-Day</th>
                <th className="px-4 py-3.5 text-center">Safety Stock</th>
                <th className="px-4 py-3.5 text-center">Reorder Pt.</th>
                <th className="px-4 py-3.5 text-center">Suggested Reorder</th>
                <th className="px-4 py-3.5 text-center">Method</th>
                <th className="px-4 py-3.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
              {skuDemandList.map((item, idx) => (
                <tr key={item.id} className={`hover:bg-slate-50/80 transition-colors ${idx % 2 === 1 ? 'bg-slate-50/40' : ''}`}>
                  <td className="px-4 py-3.5 font-mono text-[11px] font-bold text-slate-500">{item.sku}</td>
                  <td className="px-4 py-3.5 font-bold text-slate-900">{item.name}</td>
                  <td className="px-4 py-3.5 text-center">{item.stock}</td>
                  <td className="px-4 py-3.5 text-center">{item.dailyDemand} / day</td>
                  <td className="px-4 py-3.5 text-center">{item.forecast7Day}</td>
                  <td className="px-4 py-3.5 text-center text-slate-500">{item.safetyStock ?? '—'}</td>
                  <td className="px-4 py-3.5 text-center text-slate-500">{item.reorderPoint ?? '—'}</td>
                  <td className="px-4 py-3.5 text-center font-bold text-blue-600">
                    {item.reorderQty > 0 ? `+${item.reorderQty}` : '0'}
                  </td>
                  <td className="px-4 py-3.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${item.method === 'croston' ? 'bg-violet-500/10 text-violet-700' : 'bg-slate-500/10 text-slate-700'}`}>
                      {item.method || 'moving-avg'}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${
                        item.status === 'REORDER NOW'
                          ? 'bg-rose-500/10 text-rose-700 border border-rose-300/40'
                          : item.status === 'EXPIRY RISK'
                          ? 'bg-amber-500/10 text-amber-700 border border-amber-300/40'
                          : 'bg-emerald-500/10 text-emerald-700 border border-emerald-300/40'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

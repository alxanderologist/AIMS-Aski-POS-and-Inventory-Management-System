const nodemailer = require('nodemailer');
const logger = require('./logger');

let cachedTransporter = null;

function parseRecipients(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getRecipients() {
  return parseRecipients(process.env.ALERT_RECIPIENTS);
}

function isConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      getRecipients().length > 0,
  );
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!isConfigured()) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransporter;
}

async function verifyMailer() {
  const t = getTransporter();
  if (!t) {
    logger.info('[mailer] SMTP not configured — low-stock & expiry emails disabled.');
    return false;
  }
  try {
    await t.verify();
    logger.info(
      `[mailer] SMTP ready via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} → ${getRecipients().join(', ')}`,
    );
    return true;
  } catch (err) {
    logger.error({ err: err.message }, '[mailer] SMTP verify failed');
    return false;
  }
}

async function sendMail({ subject, html, text }) {
  const t = getTransporter();
  const recipients = getRecipients();
  if (!t || recipients.length === 0) return { skipped: true };
  const from = process.env.ALERT_FROM || process.env.SMTP_USER;
  const info = await t.sendMail({
    from: `"AIMS POS Alerts" <${from}>`,
    to: recipients.join(', '),
    subject,
    text,
    html,
  });
  return { messageId: info.messageId };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStockRowsHtml(products) {
  const rows = products
    .map(
      (p) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(p.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(p.category || '')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#b91c1c;">${p.stock}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${p.minStock}</td>
        </tr>`,
    )
    .join('');
  return `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;min-width:520px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;">Product</th>
          <th style="padding:8px 12px;text-align:left;">Category</th>
          <th style="padding:8px 12px;text-align:right;">Stock</th>
          <th style="padding:8px 12px;text-align:right;">Min Stock</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderStockRowsText(products) {
  return products
    .map((p) => `- ${p.name} [${p.category || 'Uncategorized'}] — ${p.stock} left (min ${p.minStock})`)
    .join('\n');
}

async function sendLowStockAlert(products) {
  if (!products || products.length === 0) return { skipped: true };
  const subject = `Low Stock Alert — ${products.length} item${products.length === 1 ? '' : 's'} at or below reorder level`;
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2 style="margin:0 0 8px;color:#111;">Low Stock Alert</h2>
      <p style="margin:0 0 12px;color:#333;">
        The following product${products.length === 1 ? ' has' : 's have'} crossed their reorder level after a recent sale.
      </p>
      ${renderStockRowsHtml(products)}
      <p style="margin-top:16px;color:#666;font-size:12px;">Sent by AIMS POS · ${new Date().toLocaleString()}</p>
    </div>`;
  const text =
    `Low Stock Alert\n\n` +
    `${products.length} product(s) crossed their reorder level:\n\n` +
    renderStockRowsText(products) +
    `\n\nSent by AIMS POS · ${new Date().toLocaleString()}\n`;
  return sendMail({ subject, html, text });
}

async function sendLowStockDigest(products) {
  if (!products || products.length === 0) return { skipped: true };
  const subject = `Daily Low Stock Digest — ${products.length} item${products.length === 1 ? '' : 's'} at or below reorder level`;
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2 style="margin:0 0 8px;color:#111;">Daily Low Stock Digest</h2>
      <p style="margin:0 0 12px;color:#333;">
        As of ${new Date().toLocaleString()}, ${products.length} product${products.length === 1 ? ' is' : 's are'} at or below their per-product reorder level.
      </p>
      ${renderStockRowsHtml(products)}
      <p style="margin-top:16px;color:#666;font-size:12px;">Sent by AIMS POS scheduled digest</p>
    </div>`;
  const text =
    `Daily Low Stock Digest\n\n` +
    `${products.length} product(s) at or below reorder level:\n\n` +
    renderStockRowsText(products) +
    `\n\nSent by AIMS POS scheduled digest\n`;
  return sendMail({ subject, html, text });
}

function renderExpiryRowsHtml(products) {
  const rows = products
    .map((p) => {
      const dateStr = p.expiryDate ? new Date(p.expiryDate).toLocaleDateString() : '—';
      const days = p.daysUntilExpiry;
      const daysLabel =
        days == null
          ? '—'
          : days < 0
            ? `Expired ${Math.abs(days)}d ago`
            : `${days} day${days === 1 ? '' : 's'}`;
      const color = days == null ? '#111' : days < 0 ? '#7f1d1d' : days <= 7 ? '#b91c1c' : '#92400e';
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(p.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(p.category || '')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${dateStr}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:${color};">${daysLabel}</td>
        </tr>`;
    })
    .join('');
  return `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;min-width:520px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;">Product</th>
          <th style="padding:8px 12px;text-align:left;">Category</th>
          <th style="padding:8px 12px;text-align:left;">Expires</th>
          <th style="padding:8px 12px;text-align:right;">Days Left</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderExpiryRowsText(products) {
  return products
    .map((p) => {
      const dateStr = p.expiryDate ? new Date(p.expiryDate).toLocaleDateString() : '—';
      const days = p.daysUntilExpiry;
      const daysLabel = days == null ? '—' : days < 0 ? `Expired ${Math.abs(days)}d ago` : `${days} day(s)`;
      return `- ${p.name} [${p.category || 'Uncategorized'}] — expires ${dateStr} — ${daysLabel}`;
    })
    .join('\n');
}

async function sendExpiryAlert(product, windowDays) {
  if (!product) return { skipped: true };
  const days = product.daysUntilExpiry;
  const subject =
    days != null && days < 0
      ? `Expiry Alert — "${product.name}" is already expired`
      : `Expiry Alert — "${product.name}" expires in ${days} day${days === 1 ? '' : 's'}`;
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2 style="margin:0 0 8px;color:#111;">Expiry Watchlist Alert</h2>
      <p style="margin:0 0 12px;color:#333;">
        <strong>${escapeHtml(product.name)}</strong> (${escapeHtml(product.category || 'Uncategorized')})
        has entered the ${windowDays}-day expiry warning window.
      </p>
      ${renderExpiryRowsHtml([product])}
      <p style="margin-top:16px;color:#666;font-size:12px;">Sent by AIMS POS · ${new Date().toLocaleString()}</p>
    </div>`;
  const text =
    `Expiry Watchlist Alert\n\n` +
    `${product.name} (${product.category || 'Uncategorized'}) has entered the ${windowDays}-day expiry warning window.\n\n` +
    renderExpiryRowsText([product]) +
    `\n\nSent by AIMS POS · ${new Date().toLocaleString()}\n`;
  return sendMail({ subject, html, text });
}

async function sendExpiryDigest(products, windowDays) {
  if (!products || products.length === 0) return { skipped: true };
  const subject = `Expiry Digest — ${products.length} product${products.length === 1 ? '' : 's'} expiring within ${windowDays} day${windowDays === 1 ? '' : 's'}`;
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2 style="margin:0 0 8px;color:#111;">Expiry Watchlist Digest</h2>
      <p style="margin:0 0 12px;color:#333;">
        As of ${new Date().toLocaleString()}, ${products.length} product${products.length === 1 ? ' is' : 's are'} at or within the <strong>${windowDays}-day</strong> expiry window.
      </p>
      ${renderExpiryRowsHtml(products)}
      <p style="margin-top:16px;color:#666;font-size:12px;">Sent by AIMS POS</p>
    </div>`;
  const text =
    `Expiry Watchlist Digest\n\n` +
    `${products.length} product(s) expiring within ${windowDays} days:\n\n` +
    renderExpiryRowsText(products) +
    `\n\nSent by AIMS POS\n`;
  return sendMail({ subject, html, text });
}

function peso(n) {
  const num = Number(n) || 0;
  return `₱${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function renderForecastKpisHtml(kpis) {
  return `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:8px 0 16px;">
      <tr>
        <td style="padding:8px 14px;background:#eff6ff;border-radius:8px;">
          <div style="font-size:10px;font-weight:700;color:#1e40af;letter-spacing:1px;">PROJECTED GROSS</div>
          <div style="font-size:20px;font-weight:900;color:#0f172a;">${peso(kpis.projectedGross)}</div>
        </td>
        <td style="width:12px;"></td>
        <td style="padding:8px 14px;background:#ecfdf5;border-radius:8px;">
          <div style="font-size:10px;font-weight:700;color:#065f46;letter-spacing:1px;">PROJECTED NET</div>
          <div style="font-size:20px;font-weight:900;color:#0f172a;">${peso(kpis.projectedNet)}</div>
        </td>
        <td style="width:12px;"></td>
        <td style="padding:8px 14px;background:${String(kpis.grossGrowth).startsWith('-') ? '#fef2f2' : '#f0fdf4'};border-radius:8px;">
          <div style="font-size:10px;font-weight:700;color:${String(kpis.grossGrowth).startsWith('-') ? '#991b1b' : '#166534'};letter-spacing:1px;">GROWTH</div>
          <div style="font-size:20px;font-weight:900;color:${String(kpis.grossGrowth).startsWith('-') ? '#991b1b' : '#166534'};">${escapeHtml(String(kpis.grossGrowth ?? '—'))}</div>
        </td>
        <td style="width:12px;"></td>
        <td style="padding:8px 14px;background:#fef2f2;border-radius:8px;">
          <div style="font-size:10px;font-weight:700;color:#991b1b;letter-spacing:1px;">HIGH-RISK SKUs</div>
          <div style="font-size:20px;font-weight:900;color:#991b1b;">${Number(kpis.highRiskSKUs) || 0}</div>
        </td>
      </tr>
    </table>`;
}

function renderForecastSkusHtml(highRisk) {
  if (!highRisk || highRisk.length === 0) {
    return `<p style="font-family:Arial,sans-serif;font-size:13px;color:#065f46;background:#ecfdf5;padding:10px 14px;border-radius:8px;margin:0 0 16px;">No high-risk SKUs — inventory looks healthy against forecast demand.</p>`;
  }
  const rows = highRisk
    .slice(0, 10)
    .map(
      (s) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(s.name || '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${Number(s.stock ?? 0)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${Number(s.forecast7Day ?? 0)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:#b91c1c;">${Number(s.reorderQty ?? 0)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:11px;font-weight:700;">${escapeHtml(s.status || '—')}</td>
        </tr>`,
    )
    .join('');
  return `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;min-width:560px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;">Product</th>
          <th style="padding:8px 12px;text-align:right;">Stock</th>
          <th style="padding:8px 12px;text-align:right;">7d Forecast</th>
          <th style="padding:8px 12px;text-align:right;">Reorder Qty</th>
          <th style="padding:8px 12px;text-align:left;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderForecastText(digest) {
  const { kpis, highRisk, sumActual, sumForecast } = digest;
  const lines = [
    'AI Demand Forecast — Daily Summary',
    '',
    `Projected Gross: ${peso(kpis.projectedGross)}`,
    `Projected Net:   ${peso(kpis.projectedNet)}`,
    `Growth:          ${kpis.grossGrowth ?? '—'}`,
    `High-risk SKUs:  ${kpis.highRiskSKUs ?? 0}`,
    '',
    `Sum of trailing actual revenue in trajectory: ${peso(sumActual)}`,
    `Sum of forecast revenue in trajectory:        ${peso(sumForecast)}`,
    '',
  ];
  if (!highRisk || highRisk.length === 0) {
    lines.push('No high-risk SKUs — inventory looks healthy against forecast demand.');
  } else {
    lines.push('Top high-risk SKUs (up to 10):');
    highRisk.slice(0, 10).forEach((s) => {
      lines.push(
        `- ${s.name || '—'} — stock ${s.stock ?? 0}, 7d forecast ${s.forecast7Day ?? 0}, reorder ${s.reorderQty ?? 0} (${s.status || '—'})`,
      );
    });
  }
  lines.push('', `Sent by AIMS POS · ${new Date().toLocaleString()}`);
  return lines.join('\n');
}

async function sendForecastDigest(digest) {
  if (!digest) return { skipped: true };
  const kpis = digest.kpis || {};
  const subject = `AI Forecast Digest — ${peso(kpis.projectedGross)} projected · ${kpis.highRiskSKUs || 0} high-risk SKUs`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;">
      <h2 style="margin:0 0 4px;color:#0f172a;">AI Demand Forecast</h2>
      <p style="margin:0 0 16px;color:#475569;font-size:13px;">Projected next-30-day performance based on your live sales history.</p>
      ${renderForecastKpisHtml(kpis)}
      <h3 style="margin:16px 0 8px;color:#0f172a;font-size:15px;">High-risk SKUs</h3>
      ${renderForecastSkusHtml(digest.highRisk)}
      <p style="margin-top:16px;color:#64748b;font-size:11px;">
        Trailing actual in trajectory: <strong>${peso(digest.sumActual)}</strong> ·
        Forecast in trajectory: <strong>${peso(digest.sumForecast)}</strong>
      </p>
      <p style="margin-top:8px;color:#94a3b8;font-size:11px;">Sent by AIMS POS · ${new Date().toLocaleString()}</p>
    </div>`;
  const text = renderForecastText(digest);
  return sendMail({ subject, html, text });
}

module.exports = {
  isConfigured,
  verifyMailer,
  sendLowStockAlert,
  sendLowStockDigest,
  sendExpiryAlert,
  sendExpiryDigest,
  sendForecastDigest,
  getRecipients,
};

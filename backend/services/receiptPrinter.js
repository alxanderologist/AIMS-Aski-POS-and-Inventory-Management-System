// Silent thermal receipt printing: raw ESC/POS straight to the printer, either over the network
// (tcp://, port 9100) or through a shared Windows print queue (printer:<share>, see
// winRawPrintDriver.js), so nothing ever opens a browser print dialog.
// Configure via RECEIPT_PRINTER_INTERFACE in backend/.env — see .env.example and print.md.

const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const logger = require('./logger');
const { STORE_INFO } = require('../config/storeInfo');
const winRawPrintDriver = require('./winRawPrintDriver');
const { WIDTH, toCols, money, fmtDateTime, renderToPrinter, buildSaleReceipt, buildVoidReceipt } = require('./receiptLayout');

const INTERFACE = process.env.RECEIPT_PRINTER_INTERFACE;
const PRINTER_TYPE = (process.env.RECEIPT_PRINTER_TYPE || 'epson').toLowerCase();

const TYPE_MAP = {
  epson: PrinterTypes.EPSON,
  star: PrinterTypes.STAR,
  tanca: PrinterTypes.TANCA,
  daruma: PrinterTypes.DARUMA,
  brother: PrinterTypes.BROTHER,
};

function isConfigured() {
  return Boolean(INTERFACE);
}

// Whole-character columns (see toCols in receiptLayout.js) so rows are exactly one printer line.
const table = (printer, cells) => printer.tableCustom(toCols(cells));

function buildPrinter() {
  return new ThermalPrinter({
    type: TYPE_MAP[PRINTER_TYPE] || PrinterTypes.EPSON,
    interface: INTERFACE,
    width: WIDTH,
    // Only used by the `printer:<share-name>` interface mode (see winRawPrintDriver.js);
    // ignored by the `tcp://` network mode.
    driver: winRawPrintDriver,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
  });
}

// Sends a layout built by receiptLayout.js to the printer. Never throws: the result says whether
// it printed, so callers can report it or ignore it.
async function printLines(lines, label) {
  if (!isConfigured()) {
    logger.info('[receipt-printer] RECEIPT_PRINTER_INTERFACE not set in backend/.env — skipping silent print.');
    return { printed: false, reason: 'not_configured' };
  }

  const printer = buildPrinter();

  const connected = await printer.isPrinterConnected().catch(() => false);
  if (!connected) {
    logger.error(`[receipt-printer] Printer not reachable at "${INTERFACE}" — skipping print.`);
    return { printed: false, reason: 'unreachable' };
  }

  renderToPrinter(printer, lines);
  printer.cut();

  try {
    await printer.execute();
    logger.info(`[receipt-printer] Printed ${label}.`);
    return { printed: true };
  } catch (err) {
    logger.error({ err: err.message }, `[receipt-printer] Print of ${label} failed`);
    return { printed: false, reason: 'error', error: err.message };
  }
}

// A sale receipt — the BIR-style sales invoice laid out in receiptLayout.js (buildSaleReceipt).
// `data.transactionNo` (or the older `transactionId`) is the printed transaction number; with
// `reprint`, the copy is marked "*** REPRINT ***" and stamped with the reprint time.
async function printReceipt(data = {}, { reprint = false } = {}) {
  const sale = { ...data, transactionNo: data.transactionNo ?? data.transactionId };
  const lines = buildSaleReceipt(sale, { reprintedAt: reprint ? new Date() : null });
  return printLines(lines, `receipt for txn ${sale.transactionNo ?? 'N/A'}${reprint ? ' (reprint)' : ''}`);
}

// A void slip (receiptLayout.buildVoidReceipt); `data` is SaleVoidModel.findReceiptData's shape.
async function printVoidReceipt(data = {}, { reprint = false } = {}) {
  const lines = buildVoidReceipt(data, { reprintedAt: reprint ? new Date() : null });
  return printLines(lines, `void ${data.voidNo ?? 'N/A'}${reprint ? ' (reprint)' : ''}`);
}

// "VOID (2)  -P120.00" — a reading's voids, already taken out of its NET.
const voidRow = (count, amount) => [
  { text: `VOID (${Number(count) || 0})`, align: 'LEFT', width: 0.6 },
  { text: `-${money(amount)}`, align: 'RIGHT', width: 0.4 },
];

const PAYMENT_LABELS = { CASH: 'CASH', CARD: 'CARD', E_wallet: 'E-WALLET' };

// Prints a cashier's Z-Reading — the supervisor-gated closing report built by
// models/ZReading.js. `report` is a ZReadingLog row (with its cashier/approvedBy relations).
// With `reprint`, the copy is marked "*** REPRINT ***" and stamped with the reprint time.
async function printZReading(report = {}, { reprint = false } = {}) {
  if (!isConfigured()) {
    logger.info('[receipt-printer] RECEIPT_PRINTER_INTERFACE not set in backend/.env — skipping silent print.');
    return { printed: false, reason: 'not_configured' };
  }

  const printer = buildPrinter();

  const connected = await printer.isPrinterConnected().catch(() => false);
  if (!connected) {
    logger.error(`[receipt-printer] Printer not reachable at "${INTERFACE}" — skipping print.`);
    return { printed: false, reason: 'unreachable' };
  }

  const payments = Array.isArray(report.paymentBreakdown) ? report.paymentBreakdown : [];
  const categories = Array.isArray(report.categoryBreakdown) ? report.categoryBreakdown : [];

  printer.alignCenter();
  printer.bold(true);
  printer.println(STORE_INFO.name);
  printer.bold(false);
  printer.println(`TIN #: ${STORE_INFO.tin}`);
  printer.println(`SN : ${STORE_INFO.sn}`);
  printer.println(STORE_INFO.addressLine1);
  printer.println(STORE_INFO.addressLine2);
  printer.newLine();

  printer.alignLeft();
  printer.println(`User : ${report.cashier?.fullName || report.cashier?.username || 'N/A'}`);
  printer.println(`${new Date(report.createdAt || Date.now()).toLocaleString()}`);
  printer.println(`TRANS NO : #${report.reportNo ?? 'N/A'}`);
  printer.newLine();

  printer.alignCenter();
  printer.bold(true);
  printer.println('Z-READING REPORT');
  if (reprint) printer.println('*** REPRINT ***');
  printer.bold(false);
  printer.newLine();

  printer.alignLeft();
  table(printer, [
    { text: 'GROSS', align: 'LEFT', width: 0.6 },
    { text: money(report.grossSales), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'POINTS AVAILED', align: 'LEFT', width: 0.6 },
    { text: money(report.pointsAvailed), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'TOTAL DISCOUNT', align: 'LEFT', width: 0.6 },
    { text: money(report.totalDiscount), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, voidRow(report.voidCount, report.voidAmount));
  printer.newLine();
  printer.bold(true);
  table(printer, [
    { text: 'NET', align: 'LEFT', width: 0.6 },
    { text: money(report.netSales), align: 'RIGHT', width: 0.4 },
  ]);
  printer.bold(false);
  printer.newLine();

  payments.forEach((p) => {
    table(printer, [
      { text: String(p.count), align: 'LEFT', width: 0.2 },
      { text: PAYMENT_LABELS[p.method] || p.method, align: 'LEFT', width: 0.4 },
      { text: money(p.amount), align: 'RIGHT', width: 0.4 },
    ]);
  });

  printer.newLine();
  printer.alignCenter();
  printer.bold(true);
  printer.println('CATEGORY TOTAL');
  printer.bold(false);
  printer.alignLeft();
  categories.forEach((c) => {
    table(printer, [
      { text: String(c.quantity), align: 'LEFT', width: 0.15 },
      { text: String(c.category).slice(0, 20), align: 'LEFT', width: 0.45 },
      { text: money(c.amount), align: 'RIGHT', width: 0.4 },
    ]);
  });

  printer.drawLine();
  printer.println(`BEGINNING TRANSACTION : ${report.beginTransactionNo || 'N/A'}`);
  printer.println(`ENDING TRANSACTION    : ${report.endTransactionNo || 'N/A'}`);
  printer.println(`OLD GRAND TOTAL : ${money(report.grandTotalBefore)}`);
  printer.println(`NEW GRAND TOTAL : ${money(report.grandTotalAfter)}`);
  printer.drawLine();

  printer.alignCenter();
  printer.bold(true);
  printer.println('***END OF REPORT***');
  printer.bold(false);
  if (reprint) printer.println(`Reprinted: ${fmtDateTime(new Date())}`);
  printer.newLine();
  printer.cut();

  try {
    await printer.execute();
    logger.info(`[receipt-printer] Printed Z-Reading ${report.reportNo ?? 'N/A'}${reprint ? ' (reprint)' : ''}.`);
    return { printed: true };
  } catch (err) {
    logger.error({ err: err.message }, '[receipt-printer] Z-Reading print failed');
    return { printed: false, reason: 'error', error: err.message };
  }
}

// Denomination rows printed on the X-Reading, in the same order/values as the on-screen
// "Export X-Reading" sheet (frontend/src/utils/exportCsv.js) — this is that same report, just
// sent to the thermal printer instead of downloaded as a .xls file.
const DENOMINATION_ROWS = [
  { key: 'p1000', value: 1000, label: 'P 1,000.00' },
  { key: 'p500', value: 500, label: 'P   500.00' },
  { key: 'p200', value: 200, label: 'P   200.00' },
  { key: 'p100', value: 100, label: 'P   100.00' },
  { key: 'p50', value: 50, label: 'P    50.00' },
  { key: 'p20', value: 20, label: 'P    20.00' },
  { key: 'p10', value: 10, label: 'P    10.00' },
  { key: 'p5', value: 5, label: 'P     5.00' },
  { key: 'p1', value: 1, label: 'P     1.00' },
  { key: 'p0_50', value: 0.5, label: 'P     0.50' },
  { key: 'p0_25', value: 0.25, label: 'P     0.25' },
  { key: 'p0_10', value: 0.1, label: 'P     0.10' },
  { key: 'p0_05', value: 0.05, label: 'P     0.05' },
  { key: 'p0_01', value: 0.01, label: 'P     0.01' },
];

// Prints the cashier's X-Reading / end-of-day cash reconciliation — the same report the
// "Export X-Reading" button on the POS screen downloads as a spreadsheet (see exportCsv.js),
// printed instead so the cashier gets a paper copy without leaving the register. `record` is a
// Reconciliation row (models/Reconciliation.js) with its cashier relation included.
async function printXReading(record = {}) {
  if (!isConfigured()) {
    logger.info('[receipt-printer] RECEIPT_PRINTER_INTERFACE not set in backend/.env — skipping silent print.');
    return { printed: false, reason: 'not_configured' };
  }

  const printer = buildPrinter();

  const connected = await printer.isPrinterConnected().catch(() => false);
  if (!connected) {
    logger.error(`[receipt-printer] Printer not reachable at "${INTERFACE}" — skipping print.`);
    return { printed: false, reason: 'unreachable' };
  }

  const shortOver = Number(record.shortOver) || 0;

  printer.alignLeft();
  printer.println(new Date(record.createdAt || Date.now()).toLocaleDateString());
  printer.println(`TRANS NO : #${record.reportNo ?? 'N/A'}`);
  printer.newLine();

  printer.alignCenter();
  printer.bold(true);
  printer.println('X-READING REPORT');
  printer.bold(false);
  printer.drawLine();

  printer.alignLeft();
  printer.println(`Cashier : ${record.cashier?.username || 'N/A'}`);
  printer.drawLine();

  table(printer, [
    { text: 'GROSS', align: 'LEFT', width: 0.6 },
    { text: money(record.grossSales), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'POINTS AVAILED', align: 'LEFT', width: 0.6 },
    { text: money(record.pointsAvailed), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'TOTAL DISCOUNT', align: 'LEFT', width: 0.6 },
    { text: money(record.totalDiscount), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, voidRow(record.voidCount, record.voidAmount));
  printer.drawLine();

  printer.bold(true);
  table(printer, [
    { text: 'NET', align: 'LEFT', width: 0.6 },
    { text: money(record.netSales), align: 'RIGHT', width: 0.4 },
  ]);
  printer.bold(false);
  printer.drawLine();

  table(printer, [
    { text: 'CASH', align: 'LEFT', width: 0.6 },
    { text: money(record.posCash ?? record.netSales), align: 'RIGHT', width: 0.4 },
  ]);
  printer.drawLine();

  printer.alignCenter();
  printer.bold(true);
  printer.println('CASHIER ACCOUNTABILITY');
  printer.bold(false);
  printer.drawLine();

  printer.alignLeft();
  DENOMINATION_ROWS.forEach(({ key, value, label }) => {
    const count = parseInt(record[key], 10) || 0;
    table(printer, [
      { text: String(count), align: 'LEFT', width: 0.2 },
      { text: label, align: 'CENTER', width: 0.4 },
      { text: money(count * value), align: 'RIGHT', width: 0.4 },
    ]);
  });
  printer.drawLine();

  table(printer, [
    { text: 'TOTAL CASH', align: 'LEFT', width: 0.6 },
    { text: money(record.cashierCash), align: 'RIGHT', width: 0.4 },
  ]);
  printer.drawLine();

  table(printer, [
    { text: 'POS CASH', align: 'LEFT', width: 0.6 },
    { text: money(record.posCash), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'CASH DISC :', align: 'LEFT', width: 0.6 },
    { text: money(record.cashDiscount), align: 'RIGHT', width: 0.4 },
  ]);
  table(printer, [
    { text: 'CASHIER CASH', align: 'LEFT', width: 0.6 },
    { text: money(record.cashierCash), align: 'RIGHT', width: 0.4 },
  ]);
  printer.bold(true);
  const shortOverTag = shortOver < 0 ? ' (SHORTAGE)' : shortOver > 0 ? ' (OVERAGE)' : '';
  table(printer, [
    { text: 'SHORT/OVER', align: 'LEFT', width: 0.6 },
    { text: money(shortOver) + shortOverTag, align: 'RIGHT', width: 0.4 },
  ]);
  printer.bold(false);
  printer.drawLine();

  printer.alignCenter();
  printer.bold(true);
  printer.println('***END OF REPORT***');
  printer.bold(false);
  printer.newLine();
  printer.cut();

  try {
    await printer.execute();
    logger.info(`[receipt-printer] Printed X-Reading ${record.reportNo ?? 'N/A'}.`);
    return { printed: true };
  } catch (err) {
    logger.error({ err: err.message }, '[receipt-printer] X-Reading print failed');
    return { printed: false, reason: 'error', error: err.message };
  }
}

module.exports = { isConfigured, printReceipt, printVoidReceipt, printXReading, printZReading };

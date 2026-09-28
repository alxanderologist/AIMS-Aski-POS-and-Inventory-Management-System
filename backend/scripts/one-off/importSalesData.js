// One-off import of the real Coop Store + Coke Talavera sales history (May-July 2026) under
// backend/data/SALES/ into Transaction/TransactionItem, for the Sales Report and Demand Forecast's
// history. This does NOT touch Product.stock or write any StockMovement rows — current stock already
// reflects the end-of-July 2026 physical count (imported by importRealData.js), which was taken AFTER
// these sales already happened, so replaying them would double-deduct. Every product is matched to the
// existing catalog by barcode; rows that don't match are skipped and reported.
//
// Usage:
//   node importSalesData.js            dry run — parses everything, prints a report, writes nothing
//   node importSalesData.js --commit   parses, then actually creates Transactions/TransactionItems
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('importSalesData.js');

const path = require('path');
const ExcelJS = require('exceljs');
const { prisma } = require('../../models/Product');

const COMMIT = process.argv.includes('--commit');
const DATA_DIR = path.join(__dirname, '../../data');
const p = (...parts) => path.join(DATA_DIR, ...parts);

const MAX_BLANK_RUN = 30;
const CASHIER_USERNAME = 'admin';
const STORE_TIMEZONE_NOON_UTC_HOUR = 4; // 12:00 Asia/Manila (UTC+8) == 04:00 UTC

// ---------- excel helpers (same as importRealData.js) ----------

const cellValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'object') {
    if (raw.result !== undefined) return raw.result;
    if (Array.isArray(raw.richText)) return raw.richText.map((r) => r.text).join('');
    if (raw.text !== undefined) return raw.text;
    return null;
  }
  return raw;
};

const asString = (v) => {
  const cv = cellValue(v);
  return cv === null || cv === undefined ? '' : String(cv).trim();
};

const asNumber = (v) => {
  const cv = cellValue(v);
  if (cv === null || cv === undefined || cv === '') return null;
  const n = Number(cv);
  return Number.isFinite(n) ? n : null;
};

const cleanBarcode = (v) => asString(v).replace(/\s+/g, '');
const normName = (v) => asString(v).toUpperCase().replace(/\s+/g, ' ');

const parseDate = (v) => {
  const cv = cellValue(v);
  if (!cv) return null;
  if (cv instanceof Date) return Number.isNaN(cv.getTime()) ? null : cv;
  const s = String(cv).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Store-local calendar date -> a UTC instant at store-local noon, so day-bucketing in reports/forecast
// (which converts createdAt through the store timezone) always lands on the same calendar day.
const toStoreNoonUtc = (localDate) => {
  const utc = new Date(Date.UTC(localDate.getFullYear(), localDate.getMonth(), localDate.getDate(), STORE_TIMEZONE_NOON_UTC_HOUR, 0, 0));
  return utc;
};

async function openWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

function buildHeaderMap(sheet, anchorHeader) {
  const anchor = anchorHeader.toUpperCase();
  for (let r = 1; r <= 10; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 6; c++) {
      if (asString(row.getCell(c).value).toUpperCase() === anchor) {
        const map = {};
        const maxC = Math.max(sheet.columnCount, 20);
        for (let cc = 1; cc <= maxC; cc++) {
          const h = asString(row.getCell(cc).value).toUpperCase();
          if (h && map[h] === undefined) map[h] = cc;
        }
        return { headerRow: r, map };
      }
    }
  }
  throw new Error(`Could not find header row (looked for "${anchorHeader}") in sheet "${sheet.name}"`);
}

const col = (map, ...candidates) => {
  for (const c of candidates) {
    const key = c.toUpperCase();
    if (map[key] !== undefined) return map[key];
  }
  return null;
};

function* dataRows(sheet, headerRow) {
  let blankRun = 0;
  const lastCol = Math.max(sheet.columnCount, 20);
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    let isBlank = true;
    for (let c = 1; c <= lastCol; c++) {
      if (asString(row.getCell(c).value) !== '') {
        isBlank = false;
        break;
      }
    }
    if (isBlank) {
      blankRun += 1;
      if (blankRun >= MAX_BLANK_RUN) return;
      continue;
    }
    blankRun = 0;
    yield row;
  }
}

// ---------- source parsers ----------

// Parses one sales sheet into a flat list of raw line rows: { date, txnNo, barcode, name, qty, unitPrice, discount }
function parseSalesSheet(sheet, sourceTag) {
  const { headerRow, map } = buildHeaderMap(sheet, 'DATE');
  const cDate = col(map, 'DATE');
  const cBarcode = col(map, 'PARTICULAR');
  const cTxn = col(map, 'TRANSACTION NO:', 'TRANSACTION');
  const cName = col(map, 'DESCRIPTION');
  const cQty = col(map, 'QTY.', 'QTY');
  const cPrice = col(map, 'UNIT PRICE', 'SRP');
  const cDiscount = col(map, 'SALES DISCOUNT');

  const rows = [];
  let skippedNoDate = 0;
  let skippedNoTxn = 0;
  let skippedBadQty = 0;
  let yearTyposFixed = 0;
  // The Coke sheets only put a transaction/OR number on the first line of each receipt, leaving
  // continuation lines blank; the Coop sheets fill every row (so this is a no-op for them). Forward-fill
  // so a blank row is grouped with the most recent explicit number.
  let lastTxnNo = null;
  for (const row of dataRows(sheet, headerRow)) {
    let date = parseDate(row.getCell(cDate).value);
    const explicitTxnNo = asString(row.getCell(cTxn).value);
    const name = asString(row.getCell(cName).value);
    if (!name) continue; // stray/blank line inside the data range
    if (!date) {
      skippedNoDate += 1;
      continue;
    }
    // Every sheet here is scoped to a single known year (2026); an off-by-one-year typo in the
    // source (e.g. "06/02/2027" instead of 2026) is corrected rather than imported as a future date.
    if (date.getFullYear() !== 2026) {
      date = new Date(2026, date.getMonth(), date.getDate());
      yearTyposFixed += 1;
    }
    if (explicitTxnNo) lastTxnNo = explicitTxnNo;
    const txnNo = lastTxnNo;
    if (!txnNo) {
      skippedNoTxn += 1;
      continue;
    }
    const qty = asNumber(row.getCell(cQty).value);
    const unitPrice = asNumber(row.getCell(cPrice).value);
    if (!qty || qty <= 0 || unitPrice === null || unitPrice < 0) {
      skippedBadQty += 1;
      continue;
    }
    const discount = asNumber(row.getCell(cDiscount).value) || 0;
    rows.push({
      sourceTag,
      date,
      txnNo,
      barcode: cleanBarcode(row.getCell(cBarcode).value),
      name,
      qty,
      unitPrice,
      discount,
    });
  }
  return { rows, skippedNoDate, skippedNoTxn, skippedBadQty, yearTyposFixed };
}

async function parseCoopMonth(sheetName, sourceTag) {
  const wb = await openWorkbook(p('SALES', '02. SALES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'));
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return parseSalesSheet(sheet, sourceTag);
}

async function parseCokeMonth(fileName, sourceTag) {
  const wb = await openWorkbook(p('SALES', fileName));
  const sheet = wb.getWorksheet('COKE');
  if (!sheet) throw new Error(`Sheet "COKE" not found in ${fileName}`);
  return parseSalesSheet(sheet, sourceTag);
}

// ---------- transaction grouping ----------

// Groups raw line rows (already tagged with a source) into transactions keyed by sourceTag + txnNo.
function groupIntoTransactions(allRows) {
  const groups = new Map();
  for (const row of allRows) {
    const key = `${row.sourceTag}|${row.txnNo}`;
    if (!groups.has(key)) groups.set(key, { sourceTag: row.sourceTag, txnNo: row.txnNo, date: row.date, lines: [] });
    groups.get(key).lines.push(row);
  }
  return [...groups.values()];
}

// ---------- main ----------

async function main() {
  console.log(COMMIT ? 'Running in COMMIT mode — this will write to the database.\n' : 'Running in DRY RUN mode — no database writes.\n');

  const [coopMay, coopJune, coopJuly, cokeMay, cokeJune, cokeJuly] = await Promise.all([
    parseCoopMonth('MAY 2026-Convie', 'COOP-2026-05'),
    parseCoopMonth('JUNE 2026-Convie', 'COOP-2026-06'),
    parseCoopMonth('JULY 2026-Convie', 'COOP-2026-07'),
    parseCokeMonth('5. SALES MAY 2026 JAZZ EAT & COKE TAL.xlsx', 'COKE-2026-05'),
    parseCokeMonth('6. SALES JUNE 2026 JAZZ EAT & COKE TAL.xlsx', 'COKE-2026-06'),
    parseCokeMonth('7. SALES JULY 2026 JAZZ EAT & COKE TAL.xlsx', 'COKE-2026-07'),
  ]);

  const sources = [
    { label: 'Coop Store — May 2026', ...coopMay },
    { label: 'Coop Store — June 2026', ...coopJune },
    { label: 'Coop Store — July 2026', ...coopJuly },
    { label: 'Coke Talavera — May 2026', ...cokeMay },
    { label: 'Coke Talavera — June 2026', ...cokeJune },
    { label: 'Coke Talavera — July 2026', ...cokeJuly },
  ];

  console.log('=== Parsed rows per sheet ===');
  const allRows = [];
  for (const s of sources) {
    console.log(
      `${s.label}: ${s.rows.length} line items` +
        (s.skippedNoDate || s.skippedNoTxn || s.skippedBadQty
          ? ` (skipped: ${s.skippedNoDate} no date, ${s.skippedNoTxn} no txn#, ${s.skippedBadQty} bad qty/price)`
          : '') +
        (s.yearTyposFixed ? ` [${s.yearTyposFixed} year typo(s) corrected to 2026]` : ''),
    );
    allRows.push(...s.rows);
  }

  // ---- match every line to an existing product by barcode, then fall back to normalized name ----
  const products = await prisma.product.findMany({ select: { id: true, barcode: true, name: true } });
  const byBarcode = new Map(products.filter((pr) => pr.barcode).map((pr) => [pr.barcode, pr]));
  const byName = new Map();
  for (const pr of products) {
    const key = normName(pr.name);
    if (!byName.has(key)) byName.set(key, pr);
  }

  let matchedByBarcode = 0;
  let matchedByName = 0;
  const unmatched = [];
  for (const row of allRows) {
    let product = row.barcode ? byBarcode.get(row.barcode) : null;
    if (product) {
      matchedByBarcode += 1;
    } else {
      product = byName.get(normName(row.name));
      if (product) matchedByName += 1;
    }
    row.product = product || null;
    if (!product) unmatched.push(row);
  }

  console.log(`\nMatched by barcode: ${matchedByBarcode}`);
  console.log(`Matched by product name (barcode missing/unrecognized): ${matchedByName}`);
  console.log(`Unmatched (no product found — will be excluded): ${unmatched.length}`);
  if (unmatched.length) {
    const sample = new Map();
    for (const r of unmatched) {
      const key = `${r.barcode || '(no barcode)'} ${r.name}`;
      sample.set(key, (sample.get(key) || 0) + 1);
    }
    console.log(
      '  examples:',
      [...sample.entries()]
        .slice(0, 10)
        .map(([k, n]) => `${k} x${n}`)
        .join(' | '),
    );
  }

  // ---- group into transactions, keeping only matched lines ----
  const groups = groupIntoTransactions(allRows);
  const transactions = [];
  let droppedEmptyTransactions = 0;
  for (const g of groups) {
    const lines = g.lines.filter((r) => r.product);
    if (lines.length === 0) {
      droppedEmptyTransactions += 1;
      continue;
    }
    let subtotal = 0;
    let discountAmount = 0;
    for (const line of lines) {
      subtotal += Math.round(line.qty * line.unitPrice * 100) / 100;
      discountAmount += Math.round(line.discount * 100) / 100;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    discountAmount = Math.max(0, Math.round(discountAmount * 100) / 100);
    const totalAmount = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
    transactions.push({
      transactionNo: `HIST-${g.sourceTag}-${g.txnNo}`,
      createdAt: toStoreNoonUtc(g.date),
      subtotal,
      discountAmount,
      totalAmount,
      lines,
    });
  }

  console.log(`\n=== Transactions to import ===`);
  console.log(`Total transactions: ${transactions.length}`);
  console.log(`Transactions dropped (every line unmatched): ${droppedEmptyTransactions}`);
  const totalItems = transactions.reduce((sum, t) => sum + t.lines.length, 0);
  console.log(`Total line items: ${totalItems}`);
  const grossTotal = transactions.reduce((sum, t) => sum + t.totalAmount, 0);
  console.log(`Total net sales value: ₱${grossTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  const byMonth = new Map();
  for (const t of transactions) {
    const key = t.createdAt.toISOString().slice(0, 7);
    byMonth.set(key, (byMonth.get(key) || 0) + 1);
  }
  console.log('By month:', [...byMonth.entries()].sort().map(([k, n]) => `${k}=${n}`).join(', '));

  console.log('\n=== Sample transactions ===');
  for (const t of transactions.slice(0, 3)) {
    console.log(`  ${t.transactionNo} | ${t.createdAt.toISOString()} | subtotal=${t.subtotal} discount=${t.discountAmount} total=${t.totalAmount} | ${t.lines.length} items`);
    for (const line of t.lines.slice(0, 3)) {
      console.log(`      ${line.product.id} ${line.name} qty=${line.qty} @${line.unitPrice}`);
    }
  }

  // ---- transactionNo collision check ----
  const txnNoSet = new Set();
  const dupes = [];
  for (const t of transactions) {
    if (txnNoSet.has(t.transactionNo)) dupes.push(t.transactionNo);
    txnNoSet.add(t.transactionNo);
  }
  console.log(`\nDuplicate transactionNo within this import: ${dupes.length}`);
  if (dupes.length) console.log('  examples:', dupes.slice(0, 5));

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to write these to the database.');
    return;
  }

  // ---- commit ----
  console.log('\n=== Committing to database ===');
  const cashier = await prisma.user.findUnique({ where: { username: CASHIER_USERNAME } });
  if (!cashier) throw new Error(`Cashier account "${CASHIER_USERNAME}" not found`);

  const existing = await prisma.transaction.findMany({
    where: { transactionNo: { in: transactions.map((t) => t.transactionNo) } },
    select: { transactionNo: true },
  });
  const existingSet = new Set(existing.map((t) => t.transactionNo));
  const toCreate = transactions.filter((t) => !existingSet.has(t.transactionNo));
  console.log(`Skipping ${transactions.length - toCreate.length} transactions that already exist (re-run safety).`);

  const CHUNK = 1000;
  let created = 0;
  let createdItems = 0;

  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const chunk = toCreate.slice(i, i + CHUNK);
    await prisma.$transaction(
      async (tx) => {
        await tx.transaction.createMany({
          data: chunk.map((t) => ({
            transactionNo: t.transactionNo,
            subtotal: t.subtotal,
            discountAmount: t.discountAmount,
            discountPercent: 0,
            supervisorAuthorized: false,
            totalAmount: t.totalAmount,
            paymentMethod: 'CASH',
            cashierId: cashier.id,
            createdAt: t.createdAt,
          })),
        });

        const inserted = await tx.transaction.findMany({
          where: { transactionNo: { in: chunk.map((t) => t.transactionNo) } },
          select: { id: true, transactionNo: true },
        });
        const idByTxnNo = new Map(inserted.map((t) => [t.transactionNo, t.id]));

        const itemRows = [];
        for (const t of chunk) {
          const transactionId = idByTxnNo.get(t.transactionNo);
          for (const line of t.lines) {
            itemRows.push({
              transactionId,
              productId: line.product.id,
              barcode: line.product.barcode,
              name: line.product.name,
              unitPrice: line.unitPrice,
              quantity: line.qty,
              subtotal: Math.round(line.qty * line.unitPrice * 100) / 100,
            });
          }
        }
        await tx.transactionItem.createMany({ data: itemRows });
        createdItems += itemRows.length;
      },
      { timeout: 120000, maxWait: 30000 },
    );
    created += chunk.length;
    console.log(`  committed ${created}/${toCreate.length} transactions...`);
  }

  console.log(`\nCreated ${created} transactions, ${createdItems} transaction items.`);
  console.log('Product.stock was not touched — these are historical records only.');
}

main()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

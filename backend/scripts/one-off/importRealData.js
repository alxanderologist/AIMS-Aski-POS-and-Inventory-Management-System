// One-off import of the real Coop Store + Coke Talavera product/stock data under backend/data/
// into Product/Supplier/StockMovement. Barcode is the dedup key: a barcode already in the DB is
// never overwritten. Historical purchases/sales are NOT replayed — each product gets a single
// OPENING StockMovement valued at its end-of-July 2026 physical count. See the plan agreed with
// the project owner for the full reasoning.
//
// Usage:
//   node importRealData.js            dry run — parses everything, prints a report, writes nothing
//   node importRealData.js --commit   parses, then actually creates Suppliers/Products/StockMovements
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('importRealData.js');

const path = require('path');
const ExcelJS = require('exceljs');
const { prisma } = require('../../models/Product');
const { changeStock } = require('../../models/stockLedger');
const { cleanSupplierName, supplierNameKey } = require('../../services/supplierName');

const COMMIT = process.argv.includes('--commit');
const DATA_DIR = path.join(__dirname, '../../data');
const p = (...parts) => path.join(DATA_DIR, ...parts);

const MAX_BLANK_RUN = 30; // consecutive empty rows before we assume a sheet's data has ended

// ---------- excel helpers ----------

const cellValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'object') {
    if (raw.result !== undefined) return raw.result; // formula cell
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
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY, as seen in the sales/purchase books
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function openWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

// Finds the header row by scanning for `anchorHeader` in column A/B, then maps header text -> column index.
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
          // Keep the first occurrence: some sheets repeat a header (e.g. "UNIT COST" appears twice
          // on the Coke inventory sheet, and the second one is often blank).
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

// Iterates data rows after the header, stopping once MAX_BLANK_RUN consecutive rows are fully empty
// (these workbooks report a bogus huge rowCount, so we can't just loop to sheet.rowCount).
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

// Coop Store: barcode -> { name, category, unitCost, stock, stockSource }
async function parseConvieFinal() {
  const wb = await openWorkbook(p('INVENTORY', 'JULY 2026', '07. FINAL INVENTORY REPORT AS OF JULY 2026-PRINTING & COOP STORE.xlsx'));
  const sheet = wb.getWorksheet('CONVIE - final');
  const { headerRow, map } = buildHeaderMap(sheet, 'BARCODE');
  const cBarcode = col(map, 'BARCODE');
  const cCategory = col(map, 'SHELF DESCRIPTION');
  const cName = col(map, 'PRODUCT NAME');
  const cCost = col(map, 'UNIT COST');
  const cActual = col(map, 'ACTUAL INVENTORY');
  const cTotal = col(map, 'TOTAL');

  const products = new Map();
  for (const row of dataRows(sheet, headerRow)) {
    const barcode = cleanBarcode(row.getCell(cBarcode).value);
    if (!barcode) continue;
    const name = asString(row.getCell(cName).value);
    if (!name) continue;
    const entry = products.get(barcode) || { name, category: '', unitCost: null, actual: null, total: null };
    entry.name = name; // last row wins
    const category = asString(row.getCell(cCategory).value);
    if (category) entry.category = category;
    const cost = asNumber(row.getCell(cCost).value);
    if (cost !== null) entry.unitCost = cost;
    const actual = asNumber(row.getCell(cActual).value);
    if (actual !== null) entry.actual = actual;
    const total = asNumber(row.getCell(cTotal).value);
    if (total !== null) entry.total = total;
    products.set(barcode, entry);
  }

  const result = new Map();
  for (const [barcode, e] of products) {
    const stock = e.actual !== null ? e.actual : e.total;
    result.set(barcode, {
      name: e.name,
      category: e.category || 'Uncategorized',
      unitCost: e.unitCost || 0,
      stock: stock !== null ? Math.max(0, Math.round(stock)) : null,
      stockSource: e.actual !== null ? 'actual' : e.total !== null ? 'computed-total' : 'unresolved',
    });
  }
  return result;
}

// Coke Talavera: barcode -> { name, category, unitCost, price, stock, stockSource }
async function parseCokeInventory() {
  const wb = await openWorkbook(p('INVENTORY', 'JULY 2026', '7. INVENTORY REPORT AS OF JULY 2026.xlsx'));
  const sheet = wb.getWorksheet('COCA COLA');
  const { headerRow, map } = buildHeaderMap(sheet, 'BARCODE');
  const cBarcode = col(map, 'BARCODE');
  const cCategory = col(map, 'SHELF DESCRIPTION');
  const cName = col(map, 'PRODUCT NAME');
  const cCost = col(map, 'UNIT COST');
  const cSrp = col(map, 'SRP');
  const cEnding = col(map, 'ENDING INVENTORY-MANUAL', 'ENDING INVENTORY - MANUAL', 'ENDING INVENTORY');

  const result = new Map();
  for (const row of dataRows(sheet, headerRow)) {
    const barcode = cleanBarcode(row.getCell(cBarcode).value);
    if (!barcode) continue;
    const name = asString(row.getCell(cName).value);
    if (!name) continue;
    const category = asString(row.getCell(cCategory).value) || 'Coca-Cola Products';
    const unitCost = asNumber(row.getCell(cCost).value) || 0;
    const srp = asNumber(row.getCell(cSrp).value);
    const ending = cEnding !== null ? asNumber(row.getCell(cEnding).value) : null;
    result.set(barcode, {
      name,
      category,
      unitCost,
      price: srp,
      stock: ending !== null ? Math.max(0, Math.round(ending)) : null,
      stockSource: ending !== null ? 'actual' : 'unresolved',
    });
  }
  return result;
}

// normalizedProductName -> { supplierName, date } (latest date wins). Used for both Coop and Coke.
async function collectSupplierLookup(sources) {
  const lookup = new Map();
  for (const { file, sheetName, supplierHeader } of sources) {
    const wb = await openWorkbook(file);
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) continue;
    const { headerRow, map } = buildHeaderMap(sheet, 'DATE');
    const cDate = col(map, 'DATE');
    const cSupplier = col(map, supplierHeader);
    const cName = col(map, 'DESCRIPTION', 'PRODUCT NAME');
    if (cSupplier === null || cName === null) continue;
    for (const row of dataRows(sheet, headerRow)) {
      const name = normName(row.getCell(cName).value);
      const supplier = cleanSupplierName(asString(row.getCell(cSupplier).value));
      if (!name || !supplier) continue;
      const date = parseDate(row.getCell(cDate).value) || new Date(0);
      const existing = lookup.get(name);
      if (!existing || date >= existing.date) lookup.set(name, { supplierName: supplier, date });
    }
  }
  return lookup;
}

// normalizedProductName -> { price, date } (latest date wins), from the Coop Store sales book.
async function collectCoopPriceLookup() {
  const lookup = new Map();
  const wb = await openWorkbook(p('SALES', '02. SALES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'));
  for (const sheetName of ['MAY 2026-Convie', 'JUNE 2026-Convie', 'JULY 2026-Convie']) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) continue;
    const { headerRow, map } = buildHeaderMap(sheet, 'DATE');
    const cDate = col(map, 'DATE');
    const cName = col(map, 'DESCRIPTION');
    const cPrice = col(map, 'UNIT PRICE');
    for (const row of dataRows(sheet, headerRow)) {
      const name = normName(row.getCell(cName).value);
      const price = asNumber(row.getCell(cPrice).value);
      if (!name || price === null || price <= 0) continue;
      const date = parseDate(row.getCell(cDate).value) || new Date(0);
      const existing = lookup.get(name);
      if (!existing || date >= existing.date) lookup.set(name, { price, date });
    }
  }
  return lookup;
}

// ---------- main ----------

async function main() {
  console.log(COMMIT ? 'Running in COMMIT mode — this will write to the database.\n' : 'Running in DRY RUN mode — no database writes.\n');

  const [coopProducts, cokeProducts, coopPriceLookup] = await Promise.all([
    parseConvieFinal(),
    parseCokeInventory(),
    collectCoopPriceLookup(),
  ]);

  const supplierLookup = await collectSupplierLookup([
    {
      file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'),
      sheetName: 'MAY 2026-COOP STORE',
      supplierHeader: 'PARTICULARS',
    },
    {
      file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'),
      sheetName: 'JUNE 2026-COOP STORE',
      supplierHeader: 'PARTICULARS',
    },
    {
      file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'),
      sheetName: 'JULY 2026-COOP STORE',
      supplierHeader: 'PARTICULARS',
    },
    {
      file: p('PURCHASES', 'PURCHASE JULY 2026 WHT AND BIGASAN.xlsx'),
      sheetName: 'CONVIE ',
      supplierHeader: "SUPPLIER'S NAME",
    },
    {
      file: p('PURCHASES', 'PURCHASE JULY 2026 WHT AND BIGASAN.xlsx'),
      sheetName: 'COKE TALAVERA',
      supplierHeader: "SUPPLIER'S NAME",
    },
  ]);

  const COKE_FALLBACK_SUPPLIER = 'COCA-COLA EUROPACIFIC ABOITIZ PHILIPPINES, INC.';

  // ---- build the final import list ----
  const toImport = []; // { barcode, name, category, unitCost, price, priceSource, stock, stockSource, supplierName, supplierSource, businessLine }
  const skipped = { noStock: [], noName: [] };

  for (const [barcode, e] of coopProducts) {
    if (e.stock === null) {
      skipped.noStock.push({ barcode, name: e.name });
      continue;
    }
    const key = normName(e.name);
    const priceHit = coopPriceLookup.get(key);
    const supplierHit = supplierLookup.get(key);
    toImport.push({
      barcode,
      name: e.name,
      category: e.category,
      unitCost: e.unitCost,
      price: priceHit ? priceHit.price : e.unitCost,
      priceSource: priceHit ? 'observed-sale' : 'fallback-cost',
      stock: e.stock,
      stockSource: e.stockSource,
      supplierName: supplierHit ? supplierHit.supplierName : null,
      supplierSource: supplierHit ? 'matched' : 'none',
      businessLine: 'Coop Store',
    });
  }

  for (const [barcode, e] of cokeProducts) {
    if (e.stock === null) {
      skipped.noStock.push({ barcode, name: e.name });
      continue;
    }
    const key = normName(e.name);
    const supplierHit = supplierLookup.get(key);
    toImport.push({
      barcode,
      name: e.name,
      category: e.category,
      unitCost: e.unitCost,
      price: e.price !== null && e.price > 0 ? e.price : e.unitCost,
      priceSource: e.price !== null && e.price > 0 ? 'srp' : 'fallback-cost',
      stock: e.stock,
      stockSource: e.stockSource,
      supplierName: supplierHit ? supplierHit.supplierName : COKE_FALLBACK_SUPPLIER,
      supplierSource: supplierHit ? 'matched' : 'fallback-single-supplier',
      businessLine: 'Coca-Cola',
    });
  }

  // ---- barcode collisions across the two sources (shouldn't happen, but check) ----
  const byBarcode = new Map();
  const collisions = [];
  for (const item of toImport) {
    if (byBarcode.has(item.barcode)) collisions.push(item.barcode);
    byBarcode.set(item.barcode, item);
  }

  // ---- report ----
  const byLine = (line) => toImport.filter((i) => i.businessLine === line);
  const countWhere = (arr, pred) => arr.filter(pred).length;

  console.log('=== Parsed summary ===');
  for (const line of ['Coop Store', 'Coca-Cola']) {
    const items = byLine(line);
    console.log(`\n${line}: ${items.length} products ready to import`);
    console.log(`  stock from actual count: ${countWhere(items, (i) => i.stockSource === 'actual')}`);
    console.log(`  stock from computed running total (no manual recount): ${countWhere(items, (i) => i.stockSource === 'computed-total')}`);
    console.log(`  price from observed sale/SRP: ${countWhere(items, (i) => i.priceSource === 'observed-sale' || i.priceSource === 'srp')}`);
    console.log(`  price fallback to cost (never observed): ${countWhere(items, (i) => i.priceSource === 'fallback-cost')}`);
    console.log(`  supplier matched by name: ${countWhere(items, (i) => i.supplierSource === 'matched')}`);
    console.log(`  supplier unresolved (left blank): ${countWhere(items, (i) => i.supplierSource === 'none')}`);
    console.log(`  supplier fallback (single known supplier): ${countWhere(items, (i) => i.supplierSource === 'fallback-single-supplier')}`);
  }
  console.log(`\nSkipped — no resolvable stock count at all: ${skipped.noStock.length}`);
  if (skipped.noStock.length) {
    console.log('  examples:', skipped.noStock.slice(0, 5).map((s) => `${s.barcode} ${s.name}`).join(' | '));
  }
  console.log(`Barcode collisions between Coop Store and Coca-Cola sheets: ${collisions.length}`);
  if (collisions.length) console.log('  ', collisions.slice(0, 10));

  const distinctSuppliers = new Set(toImport.filter((i) => i.supplierName).map((i) => supplierNameKey(i.supplierName)));
  console.log(`\nDistinct suppliers referenced: ${distinctSuppliers.size}`);

  const zeroPrice = toImport.filter((i) => !(i.price > 0));
  const zeroCost = toImport.filter((i) => !(i.unitCost > 0));
  const hugeStock = toImport.filter((i) => i.stock > 5000).sort((a, b) => b.stock - a.stock);
  console.log(`\nZero/blank selling price: ${zeroPrice.length}`);
  if (zeroPrice.length) console.log('  examples:', zeroPrice.slice(0, 5).map((i) => `${i.barcode} ${i.name}`).join(' | '));
  console.log(`Zero/blank unit cost: ${zeroCost.length}`);
  if (zeroCost.length) console.log('  examples:', zeroCost.slice(0, 5).map((i) => `${i.barcode} ${i.name}`).join(' | '));
  console.log(`Stock counts over 5000 units (sanity-check outliers): ${hugeStock.length}`);
  if (hugeStock.length) console.log('  top 10:', hugeStock.slice(0, 10).map((i) => `${i.name}=${i.stock}`).join(' | '));

  console.log('\n=== Sample rows (first 5 per line) ===');
  for (const line of ['Coop Store', 'Coca-Cola']) {
    console.log(`\n-- ${line} --`);
    for (const item of byLine(line).slice(0, 5)) {
      console.log(
        `  ${item.barcode} | ${item.name} | cat=${item.category} | cost=${item.unitCost} | price=${item.price}(${item.priceSource}) | stock=${item.stock}(${item.stockSource}) | supplier=${item.supplierName || '—'}(${item.supplierSource})`,
      );
    }
  }

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to write these to the database.');
    return;
  }

  // ---- commit ----
  console.log('\n=== Committing to database ===');
  const existing = await prisma.product.findMany({ where: { barcode: { in: [...byBarcode.keys()] } }, select: { barcode: true } });
  const existingBarcodes = new Set(existing.map((p2) => p2.barcode));

  const suppliersInDb = await prisma.supplier.findMany();
  const supplierIdByKey = new Map(suppliersInDb.map((s) => [supplierNameKey(s.name), s.id]));

  let created = 0;
  let skippedExisting = 0;
  let suppliersCreated = 0;

  for (const item of toImport) {
    if (existingBarcodes.has(item.barcode)) {
      skippedExisting += 1;
      continue;
    }

    let supplierId = null;
    if (item.supplierName) {
      const key = supplierNameKey(item.supplierName);
      supplierId = supplierIdByKey.get(key) || null;
      if (!supplierId) {
        const created2 = await prisma.supplier.create({ data: { name: cleanSupplierName(item.supplierName) } });
        supplierIdByKey.set(key, created2.id);
        supplierId = created2.id;
        suppliersCreated += 1;
      }
    }

    await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name: item.name.slice(0, 255),
          barcode: item.barcode,
          category: item.category.slice(0, 100) || 'Uncategorized',
          price: Math.max(0, Math.round(item.price * 100) / 100),
          costPrice: Math.max(0, Math.round(item.unitCost * 100) / 100),
          stock: 0,
          supplierId,
        },
      });
      if (item.stock > 0) {
        await changeStock(tx, {
          productId: product.id,
          delta: item.stock,
          type: 'OPENING',
          reason: 'Imported from July 2026 physical inventory count',
          userId: null,
        });
      }
    });
    created += 1;
  }

  console.log(`Created ${created} products (${suppliersCreated} new suppliers).`);
  console.log(`Skipped ${skippedExisting} products whose barcode already existed in the database.`);
}

main()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

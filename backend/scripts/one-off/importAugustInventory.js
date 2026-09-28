// One-off import of the August 2026 physical inventory recount (Coop Store + Coke Talavera) under
// backend/data/ into Product/Supplier/StockMovement. Unlike importRealData.js (July's baseline,
// which only ever created products), this month most products already exist: for those, stock is
// corrected to the August count via one ADJUSTMENT StockMovement (delta = August count minus current
// DB stock), and costPrice/price are updated to the August sheet's values. Brand-new barcodes get a
// fresh Product + OPENING movement, same as July. See the plan agreed with the project owner.
//
// Usage:
//   node importAugustInventory.js            dry run — parses everything, prints a report, writes nothing
//   node importAugustInventory.js --commit   parses, then actually adjusts stock / creates products
require('dotenv').config();
const { assertNotProduction } = require('../lib/productionGuard');
assertNotProduction('importAugustInventory.js');

const path = require('path');
const ExcelJS = require('exceljs');
const { prisma } = require('../../models/Product');
const { changeStock } = require('../../models/stockLedger');
const { cleanSupplierName, supplierNameKey } = require('../../services/supplierName');

const COMMIT = process.argv.includes('--commit');
const DATA_DIR = path.join(__dirname, '../../data');
const p = (...parts) => path.join(DATA_DIR, ...parts);

const MAX_BLANK_RUN = 30;

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

// Exact match first, then a "starts with" fallback: August's Coop sheet renamed "ACTUAL INVENTORY"
// to "ACTUAL INVENTORY (ANGGE)" (the recount-taker's name annotated onto the header, which can
// change every month), so an exact-only match would silently miss the column.
const col = (map, ...candidates) => {
  for (const c of candidates) {
    const key = c.toUpperCase();
    if (map[key] !== undefined) return map[key];
  }
  for (const c of candidates) {
    const key = c.toUpperCase();
    const hit = Object.keys(map).find((h) => h.startsWith(key));
    if (hit) return map[hit];
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

// Coop Store: barcode -> { name, category, unitCost, stock }
async function parseConvieAugust() {
  const wb = await openWorkbook(p('INVENTORY', '08. FINAL INVENTORY REPORT AS OF AUGUST 2026-PRINTING & COOP STORE-checked Maam Neri.xlsx'));
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
    entry.name = name;
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
    });
  }
  return result;
}

// Coke Talavera: barcode -> { name, category, unitCost, price, stock }
async function parseCokeAugust() {
  const wb = await openWorkbook(p('INVENTORY', '8. COKE INVENTORY REPORT AS OF AUGUST 2026.xlsx'));
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
    });
  }
  return result;
}

// normalizedProductName -> { supplierName, date } (latest date wins). Same May-Jul purchase books
// as the July import — reused here only to resolve suppliers for brand-new August products.
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

// normalizedProductName -> { price, date } (latest date wins), from every Coop Store sales sheet
// seen so far (May-Jul from the July workbook, August from this month's own workbook) — used only
// to price brand-new Coop products that have no inventory-sheet price column of their own.
async function collectCoopPriceLookup() {
  const lookup = new Map();
  const consider = (sheet) => {
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
  };

  const wbJul = await openWorkbook(p('SALES', '02. SALES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'));
  for (const sheetName of ['MAY 2026-Convie', 'JUNE 2026-Convie', 'JULY 2026-Convie']) {
    const sheet = wbJul.getWorksheet(sheetName);
    if (sheet) consider(sheet);
  }
  const wbAug = await openWorkbook(p('SALES', '08. SALES BOOK AUGUST 2026-PRINTING & COOP STORE.xlsx'));
  const augSheet = wbAug.getWorksheet('AUG 2026-Convie');
  if (augSheet) consider(augSheet);

  return lookup;
}

// ---------- main ----------

async function main() {
  console.log(COMMIT ? 'Running in COMMIT mode — this will write to the database.\n' : 'Running in DRY RUN mode — no database writes.\n');

  const [coopAug, cokeAug, coopPriceLookup] = await Promise.all([parseConvieAugust(), parseCokeAugust(), collectCoopPriceLookup()]);

  const supplierLookup = await collectSupplierLookup([
    { file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'), sheetName: 'MAY 2026-COOP STORE', supplierHeader: 'PARTICULARS' },
    { file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'), sheetName: 'JUNE 2026-COOP STORE', supplierHeader: 'PARTICULARS' },
    { file: p('PURCHASES', '01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx'), sheetName: 'JULY 2026-COOP STORE', supplierHeader: 'PARTICULARS' },
    { file: p('PURCHASES', 'PURCHASE JULY 2026 WHT AND BIGASAN.xlsx'), sheetName: 'CONVIE ', supplierHeader: "SUPPLIER'S NAME" },
    { file: p('PURCHASES', 'PURCHASE JULY 2026 WHT AND BIGASAN.xlsx'), sheetName: 'COKE TALAVERA', supplierHeader: "SUPPLIER'S NAME" },
  ]);
  const COKE_FALLBACK_SUPPLIER = 'COCA-COLA EUROPACIFIC ABOITIZ PHILIPPINES, INC.';

  // ---- split each business line's parsed rows into "matched" (already in DB) vs "brand new" ----
  async function classify(parsed, label) {
    const barcodes = [...parsed.keys()];
    const existing = await prisma.product.findMany({ where: { barcode: { in: barcodes } } });
    const byBarcode = new Map(existing.map((pr) => [pr.barcode, pr]));

    const matched = [];
    const brandNew = [];
    const noStock = [];
    for (const [barcode, e] of parsed) {
      if (e.stock === null) {
        noStock.push({ barcode, name: e.name });
        continue;
      }
      const dbProduct = byBarcode.get(barcode);
      if (dbProduct) {
        matched.push({
          barcode,
          productId: dbProduct.id,
          name: e.name,
          stockDelta: e.stock - dbProduct.stock,
          newCost: e.unitCost,
          costChanged: Math.abs(e.unitCost - Number(dbProduct.costPrice)) > 0.01,
          newPrice: e.price ?? null,
          priceChanged: e.price !== null && e.price > 0 && Math.abs(e.price - Number(dbProduct.price)) > 0.01,
        });
      } else {
        brandNew.push({ barcode, name: e.name, category: e.category, unitCost: e.unitCost, stock: e.stock, price: e.price });
      }
    }
    console.log(`\n=== ${label} ===`);
    console.log(`Parsed: ${parsed.size} | Matched: ${matched.length} | Brand-new: ${brandNew.length} | No resolvable count (skipped): ${noStock.length}`);
    return { matched, brandNew, noStock };
  }

  const coop = await classify(coopAug, 'Coop Store');
  const coke = await classify(cokeAug, 'Coke Talavera');

  // ---- build brand-new product records (supplier + price resolution) ----
  function prepareNew(brandNew, businessLine, fallbackSupplier) {
    return brandNew.map((e) => {
      const key = normName(e.name);
      const supplierHit = supplierLookup.get(key);
      const priceHit = businessLine === 'Coop Store' ? coopPriceLookup.get(key) : null;
      return {
        ...e,
        price: e.price !== null && e.price > 0 ? e.price : priceHit ? priceHit.price : e.unitCost,
        priceSource: e.price !== null && e.price > 0 ? 'srp' : priceHit ? 'observed-sale' : 'fallback-cost',
        supplierName: supplierHit ? supplierHit.supplierName : fallbackSupplier || null,
        supplierSource: supplierHit ? 'matched' : fallbackSupplier ? 'fallback-single-supplier' : 'none',
        businessLine,
      };
    });
  }

  const coopNew = prepareNew(coop.brandNew, 'Coop Store', null);
  const cokeNew = prepareNew(coke.brandNew, 'Coca-Cola', COKE_FALLBACK_SUPPLIER);

  // ---- report ----
  for (const [label, { matched }] of [['Coop Store', coop], ['Coke Talavera', coke]]) {
    const changed = matched.filter((m) => m.stockDelta !== 0);
    console.log(`\n${label}: ${changed.length} matched products need a stock adjustment`);
    const costChanges = matched.filter((m) => m.costChanged);
    const priceChanges = matched.filter((m) => m.priceChanged);
    console.log(`  cost changes: ${costChanges.length} | price changes: ${priceChanges.length}`);
  }
  console.log(`\nBrand-new products to create: Coop Store ${coopNew.length}, Coke Talavera ${cokeNew.length}`);
  console.log(
    'Coop new supplier resolution: matched',
    coopNew.filter((n) => n.supplierSource === 'matched').length,
    '| none',
    coopNew.filter((n) => n.supplierSource === 'none').length,
  );

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to write these to the database.');
    return;
  }

  // ---- commit ----
  console.log('\n=== Committing to database ===');
  const suppliersInDb = await prisma.supplier.findMany();
  const supplierIdByKey = new Map(suppliersInDb.map((s) => [supplierNameKey(s.name), s.id]));

  let adjusted = 0;
  let costUpdated = 0;
  let created = 0;
  let suppliersCreated = 0;

  for (const { matched } of [coop, coke]) {
    for (const m of matched) {
      if (m.stockDelta === 0 && !m.costChanged && !m.priceChanged) continue;
      await prisma.$transaction(async (tx) => {
        if (m.stockDelta !== 0) {
          await changeStock(tx, {
            productId: m.productId,
            delta: m.stockDelta,
            type: 'ADJUSTMENT',
            reason: 'August 2026 physical inventory recount',
            userId: null,
          });
          adjusted += 1;
        }
        if (m.costChanged || m.priceChanged) {
          const data = {};
          if (m.costChanged) data.costPrice = Math.max(0, Math.round(m.newCost * 100) / 100);
          if (m.priceChanged) data.price = Math.max(0, Math.round(m.newPrice * 100) / 100);
          await tx.product.update({ where: { id: m.productId }, data });
          costUpdated += 1;
        }
      });
    }
  }

  for (const item of [...coopNew, ...cokeNew]) {
    let supplierId = null;
    if (item.supplierName) {
      const key = supplierNameKey(item.supplierName);
      supplierId = supplierIdByKey.get(key) || null;
      if (!supplierId) {
        const createdSupplier = await prisma.supplier.create({ data: { name: cleanSupplierName(item.supplierName) } });
        supplierIdByKey.set(key, createdSupplier.id);
        supplierId = createdSupplier.id;
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
          reason: 'Imported from August 2026 physical inventory count',
          userId: null,
        });
      }
    });
    created += 1;
  }

  console.log(`Stock adjusted for ${adjusted} products.`);
  console.log(`Cost/price updated for ${costUpdated} products.`);
  console.log(`Created ${created} brand-new products (${suppliersCreated} new suppliers).`);
}

main()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

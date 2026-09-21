/**
 * One-shot importer for the AMPC INVENTORY 2026 workbook (May–July).
 *
 * What it loads:
 *   1. Product catalog (inventory reports + auto-created from sales lines)
 *   2. Sales-book transactions from every branch:
 *        · Printing & Coop Store (main store)
 *        · Jazz Eat & Coke Talavera
 *        · Waterhope Talavera + Bigasan
 *   3. Purchase-book rows → PurchaseOrder + ReceivingReport records so the
 *      Finance and Inventory panels have a supply-side history to work with.
 *
 * Everything the importer writes is namespaced so the revert script can find
 * and remove it in one pass:
 *   · Transaction.transactionNo            starts with "AMPC-"
 *   · PurchaseOrder.poNumber               starts with "AMPCPO-"
 *   · ReceivingReport.rrNumber             starts with "AMPCRR-"
 *   · Supplier rows created here           name is prefixed "AMPC · …"
 *   · Products created here                supplierId points at the seed
 *                                          "AMPC Import (May–July 2026)" row
 *
 * Run:   node importAmpc.js
 * Undo:  node revertAmpc.js
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { prisma } = require('./models/Product');

const BASE = 'C:/Users/LOQ/Downloads/AMPC INVENTORY 2026/AMPC INVENTORY 2026';

// ------ helpers ---------------------------------------------------------

const clean = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.text) return String(v.text).trim();
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return typeof v === 'string' ? v.trim() : v;
};

const num = (v) => {
  const c = clean(v);
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string' && c.length) {
    const n = Number(c.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const normBarcode = (v) => {
  const c = clean(v);
  if (c === '' || c === null || c === undefined) return null;
  const s = String(c).replace(/\s+/g, '').trim();
  return s.length ? s : null;
};

const CATEGORY_MAP = [
  [/chips|snack/i, 'Chips & Snacks'],
  [/wine|alcohol/i, 'Wine & Alcoholic'],
  [/bread|biscuit/i, 'Bread & Biscuits'],
  [/chocolate|candy|candies/i, 'Chocolates & Candies'],
  [/powder milk|juice|coffee/i, 'Milk, Juice & Coffee'],
  [/noodles/i, 'Noodles'],
  [/spread|canned/i, 'Canned & Spread'],
  [/condiment/i, 'Condiments'],
  [/toiletries|personal care/i, 'Toiletries'],
  [/household/i, 'Household'],
  [/clients product/i, 'Client Products'],
  [/ice cream/i, 'Ice Cream'],
  [/rtd|refri/i, 'RTD & Refrigerated'],
  [/over the counter|otc/i, 'OTC'],
  [/other products/i, 'Other Products'],
  [/super moringa|moringa/i, 'Super Moringa'],
  [/school suppl/i, 'School Supplies'],
  [/office suppl/i, 'Office Supplies'],
  [/coca[- ]cola|coke/i, 'Coca-Cola'],
];
const mapCategory = (raw) => {
  const s = String(clean(raw) || '').trim();
  if (!s) return 'Uncategorized';
  for (const [re, label] of CATEGORY_MAP) if (re.test(s)) return label;
  return s.replace(/\s+/g, ' ').slice(0, 40);
};

const parseDate = (v) => {
  const c = clean(v);
  if (c instanceof Date) return c;
  if (typeof c === 'string' && c.length) {
    const s = c.trim();
    const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m1) return new Date(`${m1[3]}-${m1[1].padStart(2, '0')}-${m1[2].padStart(2, '0')}T09:00:00`);
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m2) return new Date(`${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}T09:00:00`);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

const START = new Date('2026-05-01T00:00:00');
const END = new Date('2026-07-31T23:59:59');

// ------ product extraction ---------------------------------------------

async function extractProducts() {
  const products = new Map();

  const inventoryFiles = [
    {
      file: 'INVENTORY/JULY 2026/07. FINAL INVENTORY REPORT AS OF JULY 2026-PRINTING & COOP STORE.xlsx',
      sheets: ['PRINTING', 'CONVIE - final'],
    },
    { file: 'INVENTORY/JULY 2026/7. INVENTORY REPORT AS OF JULY 2026.xlsx', sheets: ['COCA COLA'] },
  ];

  for (const spec of inventoryFiles) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(BASE, spec.file));
    for (const sheetName of spec.sheets) {
      const ws = wb.getWorksheet(sheetName);
      if (!ws) { console.warn('missing sheet', sheetName); continue; }

      let headerRow = -1;
      for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
        const row = ws.getRow(r);
        const vals = [];
        for (let c = 1; c <= ws.columnCount; c++) vals.push(String(clean(row.getCell(c).value) || '').toUpperCase());
        if (vals.some((v) => v.includes('PRODUCT NAME')) && vals.some((v) => v.includes('BARCODE'))) { headerRow = r; break; }
      }
      if (headerRow < 0) continue;

      const header = ws.getRow(headerRow);
      const colIdx = {};
      for (let c = 1; c <= ws.columnCount; c++) {
        const h = String(clean(header.getCell(c).value) || '').toUpperCase().replace(/\s+/g, ' ').trim();
        if (h.includes('BARCODE')) colIdx.barcode ??= c;
        if (h.includes('SHELF DESCRIPTION')) colIdx.category ??= c;
        if (h.includes('PRODUCT NAME')) colIdx.name ??= c;
        if (h === 'UNIT COST') colIdx.cost ??= c;
        if (h.includes('ACTUAL INVENTORY') && !colIdx.actual) colIdx.actual = c;
        if (h.includes('QUANTITY PER RECORD') && !colIdx.actual) colIdx.actual = c;
        if (h === 'SRP') colIdx.srp ??= c;
      }
      if (!colIdx.barcode || !colIdx.name) continue;

      let added = 0;
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const bc = normBarcode(row.getCell(colIdx.barcode).value);
        const name = String(clean(row.getCell(colIdx.name).value) || '').trim();
        if (!bc || !name) continue;
        if (/^total|^grand total|^variance/i.test(name)) continue;

        const cost = num(row.getCell(colIdx.cost).value);
        const srp = colIdx.srp ? num(row.getCell(colIdx.srp).value) : null;
        const actual = colIdx.actual ? num(row.getCell(colIdx.actual).value) : null;
        const rawCat = colIdx.category ? String(clean(row.getCell(colIdx.category).value) || '').trim() : '';
        // Reject junk shelf-description leaks.
        const isValidCat = rawCat && !/^(NOT IN LIST|RECORD|ACTUAL INVENTORY|DIFF|KATHERINE|FINANCE)/i.test(rawCat);
        const category = isValidCat ? mapCategory(rawCat) : 'Uncategorized';

        const existing = products.get(bc);
        if (existing) {
          if (cost != null && (existing.cost == null || existing.cost <= 0)) existing.cost = cost;
          if (srp != null && (existing.srp == null || existing.srp <= 0)) existing.srp = srp;
          if (actual != null) existing.stock = Math.max(existing.stock || 0, actual);
          if (!existing.category || existing.category === 'Uncategorized') existing.category = category;
        } else {
          products.set(bc, {
            barcode: bc,
            name,
            category,
            cost: cost ?? null,
            srp: srp ?? null,
            stock: actual ?? 0,
          });
          added++;
        }
      }
      console.log(`  inventory "${sheetName}": +${added} new products (total ${products.size})`);
    }
  }
  return products;
}

// ------ sales extraction (all branches) --------------------------------

const SALES_SOURCES = [
  // main store
  { file: 'SALES/02. SALES BOOK MAY 2026-PRINTING & COOP STORE.xlsx',
    sheets: [
      { name: 'MAY 2026-Printing', branch: 'PRINTING' },
      { name: 'MAY 2026-Convie', branch: 'COOP' },
    ]},
  { file: 'SALES/02. SALES BOOK JUNE 2026-PRINTING & COOP STORE.xlsx',
    sheets: [
      { name: 'JUNE 2026-PRINTING', branch: 'PRINTING' },
      { name: 'JUNE 2026-Convie', branch: 'COOP' },
    ]},
  { file: 'SALES/02. SALES BOOK JULY 2026-PRINTING & COOP STORE.xlsx',
    sheets: [
      { name: 'JULY 2026-Printing', branch: 'PRINTING' },
      { name: 'JULY 2026-Convie', branch: 'COOP' },
    ]},
  // Jazz Eat + Coke Talavera
  { file: 'SALES/5. SALES MAY 2026 JAZZ EAT & COKE TAL.xlsx',
    sheets: [
      { name: 'JAZZ EAT', branch: 'JAZZEAT' },
      { name: 'COKE', branch: 'COKETAL' },
    ]},
  { file: 'SALES/6. SALES JUNE 2026 JAZZ EAT & COKE TAL.xlsx',
    sheets: [
      { name: 'JAZZ EAT', branch: 'JAZZEAT' },
      { name: 'COKE', branch: 'COKETAL' },
    ]},
  { file: 'SALES/7. SALES JULY 2026 JAZZ EAT & COKE TAL.xlsx',
    sheets: [
      { name: 'JAZZ EAT', branch: 'JAZZEAT' },
      { name: 'COKE', branch: 'COKETAL' },
    ]},
  // Waterhope + Bigasan
  { file: 'SALES/SALES MAY 2026 WHT AND BIGASAN.xlsx',
    sheets: [
      { name: 'BIGASAN', branch: 'BIGASAN' },
      { name: 'WHT', branch: 'WHT' },
    ]},
  { file: 'SALES/SALES JUNE 2026 WHT AND BIGASAN.xlsx',
    sheets: [
      { name: 'BIGASAN', branch: 'BIGASAN' },
      { name: 'WHT', branch: 'WHT' },
    ]},
  { file: 'SALES/SALES JULY 2026 WHT AND BIGASAN.xlsx',
    sheets: [
      { name: 'BIGASAN', branch: 'BIGASAN' },
      { name: 'WHT', branch: 'WHT' },
    ]},
];

async function extractSales() {
  const rows = [];
  for (const src of SALES_SOURCES) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile(path.join(BASE, src.file)); }
    catch (e) { console.warn('skip sales file', src.file, e.message); continue; }

    for (const spec of src.sheets) {
      const ws = wb.getWorksheet(spec.name);
      if (!ws) continue;

      let headerRow = -1;
      for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
        const row = ws.getRow(r);
        const vals = [];
        for (let c = 1; c <= ws.columnCount; c++) vals.push(String(clean(row.getCell(c).value) || '').toUpperCase());
        if (vals.some((v) => v === 'DATE') && vals.some((v) => v.startsWith('TRANSACTION'))) { headerRow = r; break; }
      }
      if (headerRow < 0) continue;

      const header = ws.getRow(headerRow);
      const col = {};
      for (let c = 1; c <= ws.columnCount; c++) {
        const h = String(clean(header.getCell(c).value) || '').toUpperCase().trim();
        if (h === 'DATE') col.date ??= c;
        if (h === 'PARTICULAR' || h === 'PARTICULARS') col.barcode ??= c;
        if (h.startsWith('TRANSACTION')) col.txno ??= c;
        if (h === 'DESCRIPTION') col.desc ??= c;
        if (h === 'QTY.' || h === 'QTY') col.qty ??= c;
        if (h === 'COST PRICE' || h === 'COST') col.cost ??= c;
        if (h === 'UNIT PRICE' || h === 'SRP') col.price ??= c;
      }
      if (!col.date || !col.barcode || !col.qty) continue;

      let lastDate = null, lastTx = null;
      let added = 0;
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const d = parseDate(row.getCell(col.date).value);
        if (d) lastDate = d;
        const tx = clean(row.getCell(col.txno).value);
        if (tx) lastTx = String(tx).trim();

        const bc = normBarcode(row.getCell(col.barcode).value);
        const desc = String(clean(row.getCell(col.desc).value) || '').trim();
        const qty = num(row.getCell(col.qty).value);
        const cost = col.cost ? num(row.getCell(col.cost).value) : null;
        const price = col.price ? num(row.getCell(col.price).value) : null;

        if (!lastDate || !bc || !desc || !qty || qty <= 0 || !price || price <= 0) continue;
        if (lastDate < START || lastDate > END) continue;
        if (/^total|^subtotal|^grand/i.test(desc)) continue;

        rows.push({
          date: new Date(lastDate),
          barcode: bc,
          name: desc,
          qty: Math.round(qty),
          cost: cost ?? 0,
          price,
          transactionNo: lastTx ? `AMPC-${spec.branch}-${lastTx}` : null,
          branch: spec.branch,
        });
        added++;
      }
      console.log(`  sales "${spec.name}" [${spec.branch}]: +${added} lines`);
    }
  }
  return rows;
}

// ------ purchases extraction -------------------------------------------

const PURCHASE_SOURCES = [
  { file: 'PURCHASES/01 PURCHASES BOOK MAY 2026-PRINTING & COOP STORE.xlsx',
    sheets: [
      { name: 'MAY 2026-PRINTING', branch: 'PRINTING' },
      { name: 'MAY 2026-COOP STORE', branch: 'COOP' },
    ]},
  { file: 'PURCHASES/01 PURCHASES BOOK JUNE 2026-PRINTING & COOP STORE-ok.xlsx',
    sheets: [
      { name: 'JUNE 2026-PRINTING', branch: 'PRINTING' },
      { name: 'JUNE 2026-COOP STORE', branch: 'COOP' },
    ]},
  { file: 'PURCHASES/01 PURCHASES BOOK JULY 2026-PRINTING & COOP STORE.xlsx',
    sheets: [
      { name: 'JULY 2026-PRINTING', branch: 'PRINTING' },
      { name: 'JULY 2026-COOP STORE', branch: 'COOP' },
    ]},
  { file: 'PURCHASES/6.AMPC_Purchases JUNE 2026 JAZZ EAT & COKE TAL.xlsx',
    sheets: [
      { name: 'RESTO', branch: 'JAZZEAT' },
      { name: 'COKE TALAVERA', branch: 'COKETAL' },
    ]},
  { file: 'PURCHASES/7.AMPC_Purchases JULY 2026 JAZZ EAT & COKE TAL.xlsx',
    sheets: [
      { name: 'RESTO', branch: 'JAZZEAT' },
      { name: 'COKE TALAVERA', branch: 'COKETAL' },
    ]},
  { file: 'PURCHASES/PURCHASE JULY 2026 WHT AND BIGASAN.xlsx',
    sheets: [
      { name: 'BIGASAN', branch: 'BIGASAN' },
      { name: 'WATERHOPE-TALAVERA', branch: 'WHT' },
      { name: 'CONVIE ', branch: 'COOP' },
    ]},
];

async function extractPurchases() {
  const rows = [];
  for (const src of PURCHASE_SOURCES) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile(path.join(BASE, src.file)); }
    catch (e) { console.warn('skip purchase file', src.file, e.message); continue; }
    for (const spec of src.sheets) {
      const ws = wb.getWorksheet(spec.name);
      if (!ws) continue;

      let headerRow = -1;
      for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
        const row = ws.getRow(r);
        const vals = [];
        for (let c = 1; c <= ws.columnCount; c++) vals.push(String(clean(row.getCell(c).value) || '').toUpperCase().trim());
        if (vals.some((v) => v === 'DATE') && vals.some((v) => v.includes('DESCRIPTION') || v.includes('PRODUCT NAME'))) {
          headerRow = r; break;
        }
      }
      if (headerRow < 0) continue;

      const header = ws.getRow(headerRow);
      const col = {};
      for (let c = 1; c <= ws.columnCount; c++) {
        const h = String(clean(header.getCell(c).value) || '').toUpperCase().trim();
        if (h === 'DATE') col.date ??= c;
        if (h === 'PARTICULARS' || h.includes("SUPPLIER") || h === 'PARTICULAR') col.supplier ??= c;
        if (h === 'CV NO.' || h === 'CV NO') col.cvNo ??= c;
        if (h === 'DESCRIPTION' || h === 'PRODUCT NAME') col.desc ??= c;
        if (h === 'QTY' || h === 'QTY.') col.qty ??= c;
        if (h.includes('UNIT PRICE')) col.price ??= c;
      }
      if (!col.date || !col.desc || !col.qty || !col.price) continue;

      let lastDate = null;
      let added = 0;
      let cvCounter = 0;
      for (let r = headerRow + 1; r <= Math.min(ws.rowCount, 2000); r++) {
        const row = ws.getRow(r);
        const d = parseDate(row.getCell(col.date).value);
        if (d) lastDate = d;
        const desc = String(clean(row.getCell(col.desc).value) || '').trim();
        const qty = num(row.getCell(col.qty).value);
        const price = num(row.getCell(col.price).value);
        const supplier = col.supplier ? String(clean(row.getCell(col.supplier).value) || '').trim() : '';
        const cv = col.cvNo ? String(clean(row.getCell(col.cvNo).value) || '').trim() : '';

        if (!lastDate || !desc || !qty || qty <= 0 || !price || price <= 0) continue;
        if (lastDate < START || lastDate > END) continue;
        if (/^total|^grand/i.test(desc)) continue;

        cvCounter++;
        rows.push({
          date: new Date(lastDate),
          supplier: supplier || 'UNKNOWN SUPPLIER',
          cv: cv || `AUTO-${spec.branch}-${cvCounter}`,
          desc,
          qty: Math.round(qty),
          unitPrice: price,
          branch: spec.branch,
        });
        added++;
      }
      console.log(`  purchases "${spec.name}" [${spec.branch}]: +${added} lines`);
    }
  }
  return rows;
}

// ------ main -----------------------------------------------------------

async function upsertSupplier(name) {
  const displayName = `AMPC · ${name.slice(0, 100)}`;
  const existing = await prisma.supplier.findFirst({ where: { name: displayName } });
  if (existing) return existing;
  return prisma.supplier.create({ data: { name: displayName } });
}

async function main() {
  console.log('== Extracting product catalog ==');
  const productsMap = await extractProducts();
  console.log(`  catalog size: ${productsMap.size}`);

  console.log('== Extracting sales history (all branches) ==');
  const salesRows = await extractSales();
  console.log(`  sales lines total: ${salesRows.length}`);

  console.log('== Extracting purchases (all branches) ==');
  const purchaseRows = await extractPurchases();
  console.log(`  purchase lines total: ${purchaseRows.length}`);

  const salesPrices = new Map();
  for (const s of salesRows) {
    if (!salesPrices.has(s.barcode)) salesPrices.set(s.barcode, []);
    salesPrices.get(s.barcode).push(s.price);
  }
  const priceFromSales = (bc) => {
    const arr = salesPrices.get(bc);
    if (!arr || !arr.length) return null;
    return Math.max(...arr);
  };

  for (const s of salesRows) {
    if (!productsMap.has(s.barcode)) {
      const cat = s.branch === 'JAZZEAT' ? 'Restaurant'
                : s.branch === 'BIGASAN' ? 'Fertilizer & Rice'
                : s.branch === 'WHT' ? 'Water Refill'
                : s.branch === 'COKETAL' ? 'Coca-Cola'
                : /^PRINTING/i.test(s.name) ? 'Office Supplies'
                : 'Uncategorized';
      productsMap.set(s.barcode, {
        barcode: s.barcode,
        name: s.name,
        category: cat,
        cost: s.cost || null,
        srp: null,
        stock: 0,
      });
    }
  }
  console.log(`  catalog after auto-add: ${productsMap.size}`);

  const genericSupplier = await prisma.supplier.upsert({
    where: { id: 999 },
    update: {},
    create: { id: 999, name: 'AMPC Import (May–July 2026)', contactPerson: 'AMPC' },
  }).catch(async () => {
    const existing = await prisma.supplier.findFirst({ where: { name: 'AMPC Import (May–July 2026)' } });
    return existing ?? prisma.supplier.create({ data: { name: 'AMPC Import (May–July 2026)', contactPerson: 'AMPC' } });
  });
  console.log('anchor supplier:', genericSupplier.id, genericSupplier.name);

  console.log('== Upserting products ==');
  const bcToId = new Map();
  let up = 0, skipped = 0;
  const productList = [...productsMap.values()];
  for (const p of productList) {
    const cost = p.cost && p.cost > 0 ? p.cost : 0;
    let price = p.srp && p.srp > 0 ? p.srp : priceFromSales(p.barcode);
    if (!price || price <= 0) price = cost > 0 ? +(cost * 1.15).toFixed(2) : 1;
    try {
      const rec = await prisma.product.upsert({
        where: { barcode: p.barcode },
        create: {
          barcode: p.barcode,
          name: p.name.slice(0, 200),
          category: p.category || 'Uncategorized',
          unit: 'PC/S',
          price,
          costPrice: cost,
          stock: p.stock || 0,
          minStock: 10,
          supplierId: genericSupplier.id,
        },
        update: {
          name: p.name.slice(0, 200),
          category: p.category || 'Uncategorized',
          price,
          costPrice: cost,
          stock: p.stock || 0,
        },
      });
      bcToId.set(p.barcode, rec.id);
      up++;
      if (up % 500 === 0) console.log(`  upserted ${up}/${productList.length}`);
    } catch (e) {
      skipped++;
      if (skipped < 5) console.warn(`skip product ${p.barcode}: ${e.message.slice(0, 100)}`);
    }
  }
  console.log(`products upserted=${up} skipped=${skipped}`);

  // ---- Transactions ----
  console.log('== Inserting transactions ==');
  const cashier = await prisma.user.findFirst({ where: { username: 'cashier' } });
  if (!cashier) throw new Error('No cashier user in DB');

  const txGroups = new Map();
  for (const row of salesRows) {
    const productId = bcToId.get(row.barcode);
    if (!productId) continue;
    const key = row.transactionNo || `AMPC-anon-${row.date.toISOString().slice(0,10)}-${row.barcode}`;
    if (!txGroups.has(key)) txGroups.set(key, { transactionNo: key, date: row.date, items: [] });
    txGroups.get(key).items.push({
      productId,
      barcode: row.barcode,
      name: row.name.slice(0, 200),
      unitPrice: row.price,
      quantity: row.qty,
      subtotal: +(row.price * row.qty).toFixed(2),
    });
  }
  console.log(`  distinct transactions: ${txGroups.size}`);

  const existingTxNos = new Set(
    (await prisma.transaction.findMany({
      where: { transactionNo: { startsWith: 'AMPC-' } },
      select: { transactionNo: true },
    })).map((t) => t.transactionNo),
  );

  let ins = 0, dup = 0, err = 0;
  const groups = [...txGroups.values()];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (existingTxNos.has(g.transactionNo)) { dup++; continue; }
    const subtotal = g.items.reduce((s, it) => s + it.subtotal, 0);
    try {
      await prisma.transaction.create({
        data: {
          transactionNo: g.transactionNo,
          subtotal,
          discountPercent: 0,
          discountAmount: 0,
          supervisorAuthorized: false,
          totalAmount: subtotal,
          paymentMethod: 'CASH',
          cashierId: cashier.id,
          createdAt: g.date,
          items: { create: g.items },
        },
      });
      ins++;
      if (ins % 500 === 0) console.log(`  inserted ${ins}/${groups.length - dup}`);
    } catch (e) {
      err++;
      if (err < 5) console.warn(`tx ${g.transactionNo}: ${e.message.slice(0, 100)}`);
    }
  }
  console.log(`transactions inserted=${ins} duplicates=${dup} errors=${err}`);

  // ---- Purchase Orders + Receiving Reports ----
  console.log('== Inserting purchase orders + receiving reports ==');
  const poGroups = new Map();
  for (const p of purchaseRows) {
    const productId = bcToNamedProduct(bcToId, productsMap, p.desc);
    if (!productId) continue;
    const key = `${p.branch}|${p.cv}|${p.date.toISOString().slice(0,10)}|${p.supplier}`;
    if (!poGroups.has(key)) {
      poGroups.set(key, {
        branch: p.branch, cv: p.cv, date: p.date, supplier: p.supplier, items: [],
      });
    }
    poGroups.get(key).items.push({
      productId,
      quantity: p.qty,
      unitCost: p.unitPrice,
      subtotal: +(p.qty * p.unitPrice).toFixed(2),
    });
  }
  console.log(`  distinct PO groups: ${poGroups.size}`);

  const existingPOs = new Set(
    (await prisma.purchaseOrder.findMany({
      where: { poNumber: { startsWith: 'AMPCPO-' } },
      select: { poNumber: true },
    })).map((p) => p.poNumber),
  );
  const supplierCache = new Map();

  let poIn = 0, poDup = 0, poErr = 0;
  const poList = [...poGroups.entries()];
  for (let i = 0; i < poList.length; i++) {
    const [key, po] = poList[i];
    const poNo = `AMPCPO-${po.branch}-${po.cv}-${i}`.slice(0, 60);
    if (existingPOs.has(poNo)) { poDup++; continue; }
    let supplier = supplierCache.get(po.supplier);
    if (!supplier) {
      supplier = await upsertSupplier(po.supplier);
      supplierCache.set(po.supplier, supplier);
    }
    const totalAmount = po.items.reduce((s, it) => s + it.subtotal, 0);
    try {
      const createdPo = await prisma.purchaseOrder.create({
        data: {
          poNumber: poNo,
          status: 'RECEIVED',
          terms: 'AMPC Import',
          preparedBy: 'AMPC Historical',
          totalAmount,
          supplierId: supplier.id,
          createdById: cashier.id,
          createdAt: po.date,
          items: { create: po.items },
        },
      });
      await prisma.receivingReport.create({
        data: {
          rrNumber: `AMPCRR-${po.branch}-${po.cv}-${i}`.slice(0, 60),
          invoiceNo: po.cv,
          terms: 'AMPC Import',
          purchaseOrderId: createdPo.id,
          supplierId: supplier.id,
          receivedById: cashier.id,
          receivedAt: po.date,
          items: { create: po.items.map((it) => ({ productId: it.productId, quantity: it.quantity, unitCost: it.unitCost, subtotal: it.subtotal })) },
        },
      });
      poIn++;
      if (poIn % 200 === 0) console.log(`  PO inserted ${poIn}/${poList.length}`);
    } catch (e) {
      poErr++;
      if (poErr < 5) console.warn(`PO ${poNo}: ${e.message.slice(0, 100)}`);
    }
  }
  console.log(`PO+RR inserted=${poIn} duplicates=${poDup} errors=${poErr}`);
  console.log('== Done ==');
}

// Match a purchase-line description to a product by fuzzy name lookup.
const productNameIndex = new Map();
function bcToNamedProduct(bcToId, productsMap, desc) {
  if (!productNameIndex.size) {
    for (const [bc, p] of productsMap) productNameIndex.set(p.name.toUpperCase(), bc);
  }
  const key = desc.toUpperCase();
  const bc = productNameIndex.get(key);
  if (bc) return bcToId.get(bc);
  // fallback: startsWith
  for (const [name, b] of productNameIndex) {
    if (name.startsWith(key.slice(0, 15))) return bcToId.get(b);
  }
  return null;
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

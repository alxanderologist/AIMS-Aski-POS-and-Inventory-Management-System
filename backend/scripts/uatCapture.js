/**
 * End-user UAT screen capture. Drives system Chrome via puppeteer-core to
 * walk the app as three roles (admin, cashier) and open several modals /
 * interactive states so the PDF report has real evidence.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:5173';
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'uat', 'screens');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, username, password) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input[placeholder="Enter your username"]', { timeout: 10000 });
  await page.type('input[placeholder="Enter your username"]', username);
  await page.type('input[placeholder="Enter your password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(1500);
}

async function shoot(page, label) {
  const file = path.join(OUT, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('  saved', label);
}

async function goto(page, url, waitMs = 2500) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => console.log('    nav err', e.message));
  await sleep(waitMs);
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  console.log('== ANON ==');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await sleep(1000);
  await shoot(page, '01-login');

  console.log('== Bad credentials error state ==');
  await page.type('input[placeholder="Enter your username"]', 'notreal');
  await page.type('input[placeholder="Enter your password"]', 'wrongpass');
  await page.click('button[type="submit"]');
  await sleep(1500);
  await shoot(page, '01b-login-error');
  await page.reload();
  await sleep(800);

  console.log('== ADMIN ==');
  await login(page, 'admin', 'admin123');
  await goto(page, '/adminDashboard');
  await shoot(page, '02-dashboard');

  // Notification bell
  const bell = await page.$('button[aria-label], button.rounded-full.bg-white');
  if (bell) {
    await bell.click().catch(() => {});
    await sleep(800);
    await shoot(page, '02b-notifications');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  await goto(page, '/inventoryList');
  await shoot(page, '03-inventory');

  // Add Product modal
  const addBtn = await page.$$eval('button', (btns) => {
    const idx = btns.findIndex((b) => b.innerText && b.innerText.includes('Add Product'));
    return idx;
  });
  if (addBtn >= 0) {
    await page.evaluate((idx) => {
      document.querySelectorAll('button')[idx].click();
    }, addBtn);
    await sleep(900);
    await shoot(page, '03b-add-product-modal');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  await goto(page, '/pages/ims/demand');
  await shoot(page, '04-forecasting');

  // 60-day toggle
  const sixty = await page.$$eval('button', (btns) => btns.findIndex((b) => b.innerText && b.innerText.includes('60-Day')));
  if (sixty >= 0) {
    await page.evaluate((idx) => { document.querySelectorAll('button')[idx].click(); }, sixty);
    await sleep(2500);
    await shoot(page, '04b-forecasting-60day');
  }

  await goto(page, '/pages/ims/finance');
  await shoot(page, '05-finance');

  // User Management (correct URL casing)
  await goto(page, '/pages/ims/UserManagement');
  await shoot(page, '06-users');

  console.log('== CASHIER ==');
  await page.evaluate(() => window.sessionStorage.clear());
  await login(page, 'cashier', 'cashier123');
  await goto(page, '/pos');
  await shoot(page, '07-pos-empty');

  // Add first product to cart
  const firstProd = await page.$$('div.grid button, div [class*="Product Catalog"] button');
  const productCards = await page.$$('div[class*="grid"] > div');
  // click the first product tile with a stock badge
  const tiles = await page.$$('div[class*="cursor-pointer"], div[class*="hover:scale"]');
  if (tiles.length) {
    for (let i = 0; i < Math.min(3, tiles.length); i++) {
      try { await tiles[i].click(); await sleep(400); } catch (e) {}
    }
    await sleep(800);
    await shoot(page, '07b-pos-with-cart');
  }

  // Discount modal
  const discountBtn = await page.$$eval('button', (btns) => btns.findIndex((b) => b.innerText && b.innerText.includes('Supervisor Discount')));
  if (discountBtn >= 0) {
    await page.evaluate((idx) => { document.querySelectorAll('button')[idx].click(); }, discountBtn);
    await sleep(900);
    await shoot(page, '07c-pos-discount-modal');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // Mobile viewport
  console.log('== Mobile viewport smoke ==');
  await page.setViewport({ width: 390, height: 844 });
  await sleep(600);
  await shoot(page, '08-pos-mobile');

  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => window.sessionStorage.clear());
  await login(page, 'admin', 'admin123');
  await goto(page, '/adminDashboard');
  await page.setViewport({ width: 390, height: 844 });
  await sleep(1200);
  await shoot(page, '09-dashboard-mobile');

  await browser.close();
  console.log('done');
}

run().catch((e) => { console.error(e); process.exit(1); });

/**
 * Convert docs/uat/report.html to docs/uat/AMPC-UAT-Findings.pdf via
 * puppeteer-core (system Chrome).
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTML = path.resolve(__dirname, '..', '..', 'docs', 'uat', 'report.html');
const PDF = path.resolve(__dirname, '..', '..', 'docs', 'uat', 'AMPC-UAT-Findings.pdf');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 45000 });
  await page.pdf({
    path: PDF,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
  });
  await browser.close();
  console.log('wrote', PDF);
})();

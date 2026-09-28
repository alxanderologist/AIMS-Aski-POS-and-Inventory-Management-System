// Route-level integration test for POST /api/transactions (checkout), run against a real database
// — see auth.test.js for why (CI provisions Postgres; index.js exports `app` without side effects
// when required rather than run directly). Covers the highest-value gap flagged in the deployment
// audit: nothing exercised checkout's routes/middleware directly before this.
const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { app, prisma } = require('../index.js');

const TAG = `test_checkout_${Date.now()}`;
const PASSWORD = 'correct-horse-battery-staple';
let cashier;
let accountant;
let product;
let token;
let accountantToken;

test.before(async () => {
  [cashier, accountant] = await Promise.all([
    prisma.user.create({
      data: { fullName: 'Checkout Test Cashier', username: TAG, password: await bcrypt.hash(PASSWORD, 10), role: 'CASHIER', isActive: true },
    }),
    prisma.user.create({
      data: { fullName: 'Checkout Test Accountant', username: `${TAG}_acct`, password: await bcrypt.hash(PASSWORD, 10), role: 'ACCOUNTING', isActive: true },
    }),
  ]);
  product = await prisma.product.create({
    data: { name: 'Checkout Test Product', barcode: TAG, category: 'Test', price: 50, costPrice: 30, stock: 5 },
  });

  const login = await request(app).post('/api/auth/login').send({ username: TAG, password: PASSWORD });
  token = login.body.token;
  const acctLogin = await request(app).post('/api/auth/login').send({ username: `${TAG}_acct`, password: PASSWORD });
  accountantToken = acctLogin.body.token;
});

test.after(async () => {
  await prisma.transactionItem.deleteMany({ where: { productId: product.id } });
  await prisma.transaction.deleteMany({ where: { cashierId: cashier.id } });
  await prisma.stockMovement.deleteMany({ where: { productId: product.id } });
  await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: cashier.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: accountant.id } }).catch(() => {});
  await prisma.$disconnect();
});

test('a role without POS access is rejected before any stock is touched', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${accountantToken}`)
    .send({ items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'Cash' });
  assert.equal(res.status, 403);
});

test('an empty cart is rejected', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [], paymentMethod: 'Cash' });
  assert.equal(res.status, 400);
});

test('a non-existent product is rejected', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: 999999999, quantity: 1 }], paymentMethod: 'Cash' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PRODUCT_NOT_FOUND');
});

test('requesting more than the available stock is rejected and leaves stock unchanged', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product.id, quantity: 999 }], paymentMethod: 'Cash' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INSUFFICIENT_STOCK');

  const unchanged = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(unchanged.stock, 5);
});

test('a valid cash sale succeeds, totals the correct amount, and decrements stock', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product.id, quantity: 2 }], paymentMethod: 'Cash' });
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.totalAmount), 100); // 2 x price(50), no discount

  const after = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(after.stock, 3); // 5 - 2
});

test('a card sale without a reference number is rejected', async () => {
  const res = await request(app)
    .post('/api/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'Card' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'REFERENCE_NUMBER_REQUIRED');
});

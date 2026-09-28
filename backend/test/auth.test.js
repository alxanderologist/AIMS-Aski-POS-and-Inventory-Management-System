// Route-level integration test for POST /api/auth/login, run against a real database (see
// deployment.md Phase 4 — CI provisions a throwaway Postgres and runs `prisma migrate deploy`
// before this suite). Uses supertest against the exported `app` (see index.js's
// `require.main === module` guard: requiring it here never binds the real port or starts crons).
const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { app, prisma } = require('../index.js');

const TAG = `test_auth_${Date.now()}`;
const PASSWORD = 'correct-horse-battery-staple';
let user;

test.before(async () => {
  user = await prisma.user.create({
    data: {
      fullName: 'Auth Test Cashier',
      username: TAG,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'CASHIER',
      isActive: true,
    },
  });
});

test.after(async () => {
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
});

test('correct credentials return a token and the user (password never included)', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: TAG, password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.user.username, TAG);
  assert.equal(res.body.user.password, undefined);
});

test('wrong password is rejected without revealing whether the username exists', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: TAG, password: 'not-the-password' });
  assert.equal(res.status, 401);
  assert.equal(res.body.token, undefined);
});

test('an unknown username gets the same rejection shape as a wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: `${TAG}_nobody`, password: 'whatever' });
  assert.equal(res.status, 401);
  assert.equal(res.body.token, undefined);
});

test('a deactivated account cannot log in even with the correct password', async () => {
  await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
  const res = await request(app).post('/api/auth/login').send({ username: TAG, password: PASSWORD });
  assert.equal(res.status, 401);
  await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
});

test('a protected route rejects a request with no token', async () => {
  const res = await request(app).get('/api/products');
  assert.equal(res.status, 401);
});

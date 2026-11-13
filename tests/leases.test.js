// Leases: tenancies, their monthly rent, and payments that land in the ledger as rent
// (income) or security deposits (held, not income). Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');

let dir;
let db;
let app;
let base;
let cookie;

const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();
const ledger = async () => (await get('/api/bank/transactions?kind=all&preset=all&limit=200')).transactions;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-leases-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  // A business checking account with one tenant's rent in it.
  await post('/api/bank/import', {
    content: 'Date,Description,Amount\n03/02/2026,ZELLE FROM PAT EXAMPLE,1200.00\n',
    fileName: 'checking.csv',
    newAccount: { name: 'Business checking', kind: 'checking', owner: 'business' },
  });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let leaseId;

test('a lease with its monthly rent', async () => {
  const { lease } = await post('/api/leases', { ref: 'T1', unit: 'Teal', tenant: 'Pat Example', start: '2026-01-15', end: '2026-04-14', rent: 3600, deposit: 400, channel: 'Zelle' });
  leaseId = lease.id;
  assert.equal(lease.status, 'ended', 'ended before today');
  const { schedule } = await post(`/api/leases/${leaseId}/schedule`, {
    months: [
      { month: '2026-01', amount: 600, note: 'Half month' },
      { month: '2026-02', amount: 1200 },
      { month: '2026-03', amount: 1200 },
      { month: '2026-04', amount: 600 },
    ],
  });
  assert.equal(schedule.length, 4);
  assert.ok(schedule.every((m) => m.state === 'due'));
});

test('payments outside the bank become rent and deposit transactions', async () => {
  // One Zelle of rent and the deposit, recorded as two parts.
  await post(`/api/leases/${leaseId}/payments`, { date: '2026-01-14', amount: 600, purpose: 'rent', channel: 'Zelle personal' });
  await post(`/api/leases/${leaseId}/payments`, { date: '2026-01-14', amount: 400, purpose: 'deposit', channel: 'Zelle personal' });
  await post(`/api/leases/${leaseId}/payments`, { date: '2026-02-01', amount: 1200, purpose: 'rent', verified: false });
  // At the end, part of the deposit is kept for the last rent and the rest paid back.
  await post(`/api/leases/${leaseId}/payments`, { date: '2026-04-20', amount: 250, purpose: 'refund' });
  const detail = await post(`/api/leases/${leaseId}/payments`, { date: '2026-04-20', amount: 150, purpose: 'applied' });

  const rows = (await ledger()).filter((t) => t.sources.includes('lease'));
  const pick = (re) => rows.filter((t) => re.test(t.description)).map((t) => [t.amount, t.category, t.kind, t.status]);
  assert.deepEqual(pick(/^Lease rent ·/), [[1200, 'Rental Income', 'normal', 'business'], [600, 'Rental Income', 'normal', 'business']]);
  assert.deepEqual(pick(/^Lease rent from deposit/), [[150, 'Rental Income', 'normal', 'business']]);
  assert.deepEqual(pick(/^Security deposit ·/), [[400, 'Security Deposits', 'ignored', 'business']]);
  assert.deepEqual(pick(/returned/), [[-250, 'Security Deposits', 'ignored', 'business']]);
  assert.deepEqual(pick(/kept for rent/), [[-150, 'Security Deposits', 'ignored', 'business']]);
  assert.ok(rows.every((t) => t.account === 'Rent received outside the bank'));
  assert.match(rows.find((t) => t.amount === 1200).note, /not confirmed/);

  assert.equal(detail.lease.collected, 1950);
  assert.equal(detail.lease.depositHeld, 0);
  assert.equal(detail.lease.unverified, 1);
  assert.deepEqual(detail.schedule.map((m) => m.state), ['paid', 'paid', 'partial', 'due']);
});

test('rent that reached the bank links to its transaction instead', async () => {
  const { transactions } = await get(`/api/leases/${leaseId}/candidates`);
  const zelle = transactions.find((t) => t.amount === 1200);
  assert.ok(zelle);
  await assert.rejects(post(`/api/leases/${leaseId}/payments`, { date: '2026-03-02', amount: 1100, purpose: 'rent', transactionId: zelle.id }), /must match/);
  const detail = await post(`/api/leases/${leaseId}/payments`, { date: '2026-03-02', amount: 1200, purpose: 'rent', transactionId: zelle.id });
  assert.deepEqual(detail.payments.find((p) => p.linked).transactions, [zelle.id]);
  const tx = (await ledger()).find((t) => t.id === zelle.id);
  assert.equal(tx.category, 'Rental Income');
  assert.equal(tx.account, 'Business checking');
  assert.equal(detail.lease.owed, 450, 'Jan to Apr: 3,600 due, 3,150 paid');
  // Nothing was added for it.
  assert.equal((await ledger()).filter((t) => t.sources.includes('lease')).length, 6);
});

test('lease rent is its own income source on the dashboard', async () => {
  const { byMonth } = await get('/api/bank/spending?preset=all');
  const jan = byMonth.find((m) => m.month === '2026-01');
  assert.equal(jan.sources.lease, 600, 'the deposit is not income');
  assert.equal(jan.income, 600);
});

test('removing a payment or a lease takes its transactions out of the ledger', async () => {
  const { payments } = await get(`/api/leases/${leaseId}`);
  const linked = payments.find((p) => p.linked);
  await post(`/api/leases/${leaseId}/payments/${linked.id}/delete`);
  const tx = (await ledger()).find((t) => t.id === linked.transactions[0]);
  assert.ok(tx, 'a bank transaction stays');
  assert.notEqual(tx.categorySource, 'user');

  const { leases, totals } = await get('/api/leases');
  assert.equal(leases.length, 1);
  assert.equal(totals.rentThisYear, 1950);
  await post(`/api/leases/${leaseId}/delete`);
  assert.equal((await ledger()).filter((t) => t.sources.includes('lease')).length, 0);
  assert.equal((await get('/api/leases')).leases.length, 0);
});

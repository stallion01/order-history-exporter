// Profit and loss: revenue less operating expenses, with transfers, deposits, personal
// spending and capital purchases kept out, and returns on the money invested.
// Made-up data only.
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

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-pl-'));
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

  const csv = [
    'Date,Description,Amount',
    // 2024: two months of business.
    '11/01/2024,PURCHASE WIRE OUT,-500000.00',
    '11/05/2024,AIRBNB 4000 PAYMENTS,3000.00',
    '12/05/2024,AIRBNB 4000 PAYMENTS,3000.00',
    '12/10/2024,CITY WATER DEPT,-1000.00',
    // 2025: a full year.
    '01/05/2025,AIRBNB 4000 PAYMENTS,20000.00',
    '02/05/2025,VRBO PAYOUT,10000.00',
    '03/05/2025,CITY WATER DEPT,-4000.00',
    '04/05/2025,HOME DEPOT 123,-2600.00',
    '04/20/2025,HOME DEPOT 123,100.00',
    '05/05/2025,LOWES 456,-5000.00',
    '06/05/2025,GROCERY MART,-300.00',
    '07/05/2025,ONLINE TRANSFER TO SAV,-7000.00',
    '',
  ].join('\n');
  await post('/api/bank/import', { content: csv, fileName: 'checking.csv', newAccount: { name: 'Checking', kind: 'checking', owner: 'business' } });
  const { transactions } = await get('/api/bank/transactions?kind=all&preset=all&limit=200');
  const find = (re) => transactions.find((t) => re.test(t.description));
  // The purchase and the transfer aren't spending; groceries were personal; the
  // Lowe's purchase was capital.
  await post('/api/bank/transactions/update', { ids: [find(/WIRE/).id, find(/TRANSFER/).id], kind: 'transfer' });
  await post('/api/bank/transactions/update', { ids: [find(/GROCERY/).id], status: 'personal' });
  await post('/api/bank/transactions/update', { ids: transactions.filter((t) => /AIRBNB|VRBO/.test(t.description)).map((t) => t.id), category: 'Rental Income' });
  await post('/api/assets', { description: 'Deck', cost: 5000, placedInService: '2025-05-05', transactionId: find(/LOWES/).id, recovery: '27.5' }).catch(() => null);
  if (!(await get('/api/assets')).assets.length) throw new Error('could not add the asset');
  // A lease's deposit is held, not income.
  const { lease } = await post('/api/leases', { unit: 'Teal', tenant: 'Pat Example', start: '2025-08-01', end: '2025-12-31' });
  await post(`/api/leases/${lease.id}/payments`, { date: '2025-08-01', amount: 2000, purpose: 'rent' });
  await post(`/api/leases/${lease.id}/payments`, { date: '2025-08-01', amount: 500, purpose: 'deposit' });
  await post('/api/pl/settings', { invested: 500000, investedOn: '2024-11-01' });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a year: revenue by source, expenses net of refunds, capital and personal left out', async () => {
  const pl = await get('/api/pl?period=2025');
  assert.equal(pl.revenue, 32000);
  assert.deepEqual(
    pl.sources.map((s) => [s.key, s.amount]),
    [
      ['airbnb', 20000],
      ['vrbo', 10000],
      ['lease', 2000],
    ]
  );
  assert.equal(pl.expenses, 4000 + 2500, 'water, and Home Depot less its refund');
  assert.equal(pl.capital, 5000);
  assert.equal(pl.noi, 32000 - 6500);
  assert.equal(pl.days, 365);
  assert.equal(pl.annualReturn, (32000 - 6500) / 500000);
  assert.equal(pl.months.find((m) => m.month === '2025-05').capital, 5000);
  assert.equal(pl.months.find((m) => m.month === '2025-05').expenses, 0);
});

test('years are compared on a full-year footing', async () => {
  const { years } = await get('/api/pl?period=2025');
  const [y2024, y2025] = years;
  assert.equal(y2024.year, '2024');
  assert.equal(y2024.from, '2024-11-01', 'from the day of the investment');
  assert.equal(y2024.days, 61);
  assert.equal(y2024.noi, 5000);
  assert.equal(y2024.annualNoi, Math.round(((5000 * 365) / 61) * 100) / 100);
  assert.equal(y2025.year, '2025');
  assert.ok(Math.abs(y2025.revenueChange - (32000 / ((6000 * 365) / 61) - 1)) < 1e-6);
});

test('since the start: what was put in and how much has come back', async () => {
  const { sinceStart, settings } = await get('/api/pl?period=all');
  assert.deepEqual(settings, { invested: 500000, investedOn: '2024-11-01' });
  assert.equal(sinceStart.noi, 5000 + 25500);
  assert.equal(sinceStart.invested, 505000, 'the purchase and the capital improvement');
  assert.equal(sinceStart.recovered, 30500 / 500000);
  await assert.rejects(get('/api/pl?period=nonsense').then((r) => (r.error ? Promise.reject(new Error(r.error)) : r)), /period/);
});

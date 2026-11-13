// Several businesses kept apart: a short-term rental and a long-term rental, each with
// its own accounts, tax form, investment, leases and profit and loss. Made-up data only.
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
let str;
let ltr;

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-business-'));
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

  str = (await post('/api/entities', { name: 'Lakeside Stays LLC', kind: 'business', activity: 'str', taxForm: 'form-1065', invested: 1000000, investedOn: '2026-01-01' })).id;
  ltr = (await post('/api/entities', { name: 'Maple Rentals LLC', kind: 'rental', activity: 'ltr', taxForm: 'form-8825', invested: 400000, investedOn: '2026-01-01' })).id;

  const strAccount = (
    await post('/api/bank/import', {
      content: 'Date,Description,Amount\n02/03/2026,AIRBNB 4000 PAYMENTS,5000.00\n02/10/2026,HOME DEPOT 123,-1000.00\n',
      fileName: 'str.csv',
      newAccount: { name: 'Lakeside checking', kind: 'checking', owner: 'business' },
    })
  ).accountId;
  const ltrAccount = (
    await post('/api/bank/import', {
      content: 'Date,Description,Amount\n02/01/2026,RENT PAYMENT UNIT 2,2000.00\n02/12/2026,HOME DEPOT 456,-300.00\n',
      fileName: 'ltr.csv',
      newAccount: { name: 'Maple checking', kind: 'checking', owner: 'business' },
    })
  ).accountId;
  await post(`/api/bank/accounts/${strAccount}`, { entityId: str });
  await post(`/api/bank/accounts/${ltrAccount}`, { entityId: ltr });
  const { transactions } = await get('/api/bank/transactions?kind=all&preset=all&limit=200');
  await post('/api/bank/transactions/update', { ids: transactions.filter((t) => t.amount > 0).map((t) => t.id), category: 'Rental Income' });
  await post('/api/bank/transactions/update', { ids: transactions.filter((t) => t.amount < 0).map((t) => t.id), category: 'Contractor Repairs' });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each business keeps its type, form and investment', async () => {
  const { entities } = await get('/api/entities');
  const byName = Object.fromEntries(entities.map((e) => [e.name, e]));
  assert.deepEqual(
    [byName['Lakeside Stays LLC'].activity, byName['Lakeside Stays LLC'].taxForm, byName['Lakeside Stays LLC'].invested, byName['Lakeside Stays LLC'].investedOn],
    ['str', 'form-1065', 1000000, '2026-01-01']
  );
  assert.deepEqual([byName['Maple Rentals LLC'].activity, byName['Maple Rentals LLC'].taxForm], ['ltr', 'form-8825']);
  // Renaming alone leaves the rest as it was.
  await post(`/api/entities/${ltr}`, { name: 'Maple Rentals LLC', kind: 'rental' });
  assert.equal((await get('/api/entities')).entities.find((e) => e.id === ltr).invested, 400000);
});

test('profit and loss for one business, and for all of them side by side', async () => {
  const one = await get(`/api/pl?period=2026&entity=${str}`);
  assert.equal(one.revenue, 5000);
  assert.equal(one.expenses, 1000);
  assert.equal(one.noi, 4000);
  assert.equal(one.settings.invested, 1000000);
  assert.equal(one.annualReturn, one.annualNoi / 1000000, 'on its own investment, not both');
  assert.deepEqual(one.sources.map((s) => [s.key, s.amount]), [['airbnb', 5000]]);

  const other = await get(`/api/pl?period=2026&entity=${ltr}`);
  assert.equal(other.revenue, 2000);
  assert.equal(other.expenses, 300);
  assert.equal(other.settings.invested, 400000);

  const all = await get('/api/pl?period=2026');
  assert.equal(all.revenue, 7000);
  assert.equal(all.settings.invested, 1400000, 'what was put into both');
  assert.deepEqual(
    all.businesses.map((b) => [b.name, b.revenue, b.expenses, b.noi]),
    [
      ['Lakeside Stays LLC', 5000, 1000, 4000],
      ['Maple Rentals LLC', 2000, 300, 1700],
    ]
  );
  assert.equal(all.unassigned, 0);

  // A business's investment can be changed from the P&L page.
  await post('/api/pl/settings', { entityId: ltr, invested: 450000, investedOn: '2026-01-01' });
  assert.equal((await get(`/api/pl?period=2026&entity=${ltr}`)).settings.invested, 450000);
});

test("the year's summary puts each business on its own form", async () => {
  const { summary } = await get('/api/cpa/summary?year=2026');
  const byName = Object.fromEntries(summary.map((g) => [g.entity, g]));
  assert.equal(byName['Lakeside Stays LLC'].form, 'form-1065');
  assert.deepEqual(byName['Lakeside Stays LLC'].lines, [{ line: '11', amount: 1000 }], 'repairs and maintenance');
  assert.equal(byName['Maple Rentals LLC'].form, 'form-8825');
  assert.deepEqual(byName['Maple Rentals LLC'].lines, [{ line: '11', amount: 300 }], 'repairs');
  const { forms } = await get('/api/categories');
  assert.ok(forms['form-1065'] && forms['form-8825']);
});

test("store orders follow the business chosen: by the card that paid or the place they went", async () => {
  await post('/api/orders', {
    store: 'amazon',
    orders: [
      { orderId: 'A-1', detailRead: true, items: [{ name: 'Thing 1', price: 1, quantity: 1 }], date: '2026-02-05', total: 40, payment: 'Visa ending 1111', deliveryZip: '99901' },
      { orderId: 'A-2', detailRead: true, items: [{ name: 'Thing 2', price: 1, quantity: 1 }], date: '2026-02-06', total: 25, payment: 'Visa ending 2222', deliveryZip: '99902' },
      { orderId: 'A-3', detailRead: true, items: [{ name: 'Thing 3', price: 1, quantity: 1 }], date: '2026-02-07', total: 10, payment: 'Visa ending 3333', deliveryZip: '99903' },
    ],
  });
  const card = (
    await post('/api/bank/import', {
      content: 'Date,Description,Amount\n03/01/2026,COFFEE,-5.00\n',
      fileName: 'card.csv',
      newAccount: { name: 'Lakeside card (1111)', kind: 'credit', owner: 'business' },
    })
  ).accountId;
  await post(`/api/bank/accounts/${card}`, { entityId: str });
  await post('/api/places/entity', { zip: '99902', entityId: ltr });

  const one = await get(`/api/report?years=2026&entity=${str}`);
  assert.equal(one.totals.orders, 1, 'paid on its card');
  assert.equal(one.totals.spend, 40);
  assert.equal(one.totals.unassigned, 1, 'the order nothing ties to a business');
  const other = await get(`/api/report?years=2026&entity=${ltr}`);
  assert.deepEqual([other.totals.orders, other.totals.spend], [1, 25], 'delivered to its place');
  assert.equal((await get('/api/report?years=2026')).totals.orders, 3, 'all businesses');
  assert.equal((await get(`/api/orders?years=2026&entity=${ltr}`)).orders.map((o) => o.orderId).join(), 'A-2');
});

test("a lease's payments go to its own business's account", async () => {
  const { lease } = await post('/api/leases', { unit: 'Unit 2', tenant: 'Pat Example', start: '2026-02-01', entityId: ltr });
  assert.equal(lease.entityId, ltr);
  await post(`/api/leases/${lease.id}/payments`, { date: '2026-03-01', amount: 2000, purpose: 'rent' });
  const { leases } = await get(`/api/leases?entity=${str}`);
  assert.equal(leases.length, 0, "not the other business's");
  const { accounts } = await get('/api/bank/accounts');
  const outside = accounts.find((a) => a.name === 'Rent received outside the bank (Maple Rentals LLC)');
  assert.ok(outside);
  assert.equal(outside.entityId, ltr);
  assert.equal((await get(`/api/pl?period=2026&entity=${ltr}`)).sources.find((s) => s.key === 'lease').amount, 2000);
  assert.equal((await get(`/api/pl?period=2026&entity=${str}`)).revenue, 5000, 'unchanged');
});

test('cash flow: income, spending by group, loan principal, net worth and cash-on-cash', async () => {
  const birch = (await post('/api/entities', { name: 'Birch Stays LLC', kind: 'business', activity: 'str', taxForm: 'form-1065', invested: 100000, investedOn: '2020-01-01' })).id;
  // Last month, whatever today is.
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const day = `${String(last.getMonth() + 1).padStart(2, '0')}/10/${last.getFullYear()}`;
  const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
  const account = (
    await post('/api/bank/import', {
      content: `Date,Description,Amount\n${day},AIRBNB 4000 PAYMENTS,3000.00\n${day},CITY WATER DEPT,-200.00\n${day},MORTGAGE PRINCIPAL,-1000.00\n`,
      fileName: 'birch.csv',
      newAccount: { name: 'Birch checking', kind: 'checking', owner: 'business' },
    })
  ).accountId;
  await post(`/api/bank/accounts/${account}`, { entityId: birch });
  const { transactions } = await get(`/api/bank/transactions?kind=all&preset=all&account=${account}&limit=50`);
  const by = (text) => transactions.find((t) => t.description.includes(text)).id;
  await post('/api/bank/transactions/update', { ids: [by('AIRBNB')], category: 'Rental Income' });
  await post('/api/bank/transactions/update', { ids: [by('WATER')], category: 'Utilities' });
  await post('/api/bank/transactions/update', { ids: [by('PRINCIPAL')], category: 'Loan & Mortgage Payments', kind: 'transfer' });

  const flow = await get(`/api/pl/cashflow?entity=${birch}`);
  assert.equal(flow.months.length, 13, 'a year and this month');
  assert.equal(flow.lastMonth.month, month);
  assert.deepEqual([flow.lastMonth.income, flow.lastMonth.groups.Utilities, flow.lastMonth.groups['Mortgages & Loans'], flow.lastMonth.net], [3000, 200, 1000, 1800]);
  assert.deepEqual([flow.ttm.income, flow.ttm.expenses, flow.ttm.debt, flow.ttm.net], [3000, 200, 1000, 1800]);
  assert.equal(flow.average, 150);
  assert.equal(flow.cashOnCash, 0.018);
  assert.equal(flow.cocSeries.at(-1).value, 0.018);
  assert.ok(flow.groupCategories.Utilities.includes('Utilities'), 'each group lists its categories, for links');
  assert.ok(flow.groupCategories['Mortgages & Loans'].includes('Loan & Mortgage Payments'));
  assert.ok(flow.groupCategories['Admin & Other'].includes('none'), 'uncategorised spending');
  // The capital-purchases link: only charges on the asset register.
  assert.equal((await get(`/api/bank/transactions?kind=all&preset=all&account=${account}&asset=1`)).transactions.length, 0);
  assert.equal((await get(`/api/bank/transactions?kind=all&preset=all&account=${account}`)).transactions.length, 3);

  await post('/api/pl/market-value', { entityId: birch, value: 250000 });
  const worth = (await get(`/api/pl/cashflow?entity=${birch}`)).netWorth;
  assert.deepEqual([worth.value, worth.debt, worth.total], [250000, 0, 250000 + worth.cash]);
});

// "Store, unless on a Business card": a store's orders and charges are personal unless
// paid with a card on an account marked Business; the dashboard leaves personal out.
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

const OFX = (accountNumber, tx) => `OFXHEADER:100\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>${accountNumber}</CCACCTFROM><BANKTRANLIST>
${tx.map(([d, a, n], i) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d}<TRNAMT>${a}<FITID>${accountNumber.slice(-4)}-${i}<NAME>${n}</STMTTRN>`).join('\n')}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-storecard-'));
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

  await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify({
      store: 'samsclub',
      orders: [
        { orderId: 'S1', date: '2026-04-01', total: 80, payment: 'Mastercard ending 4321', items: [{ name: 'Paper Towels', price: 80, quantity: 1 }] },
        { orderId: 'S2', date: '2026-04-02', total: 30, payment: 'Card ending 9999', items: [{ name: 'Snack Mix', price: 30, quantity: 1 }] },
        { orderId: 'S3', date: '2026-04-03', total: 12, items: [{ name: 'Batteries', price: 12, quantity: 1 }] },
      ],
    }),
  });
  await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify({ store: 'walmart', orders: [{ orderId: 'W1', storeName: 'Walmart', date: '2026-04-04', total: 15, payment: 'Card ending 9999', items: [{ name: 'Light Bulbs', price: 15, quantity: 1 }] }] }),
  });

  await post('/api/bank/import', {
    content: OFX('4111111111114321', [['20260415', '-45.00', 'SAMSCLUB #0000 ANYTOWN']]),
    fileName: 'business.qfx',
    newAccount: { name: 'Business card', kind: 'credit', owner: 'business' },
  });
  await post('/api/bank/import', {
    content: OFX('4111111111119999', [
      ['20260416', '-25.00', 'SAMS CLUB #0000 ANYTOWN'],
      ['20260417', '-10.00', 'SHELL OIL 00000'],
    ]),
    fileName: 'other.qfx',
    newAccount: { name: 'Other card', kind: 'credit', owner: 'mixed' },
  });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const items = async () => Object.fromEntries((await get('/api/items?store=samsclub&store=walmart')).items.map((i) => [i.orderId, i.status]));
const charges = async () => Object.fromEntries((await get('/api/bank/transactions?kind=all')).transactions.map((t) => [t.description.split(' ')[0], t.status]));

test('the rule makes everything at that store personal unless it was on a Business card', async () => {
  assert.deepEqual(await items(), { S1: 'unreviewed', S2: 'unreviewed', S3: 'unreviewed', W1: 'unreviewed' });
  assert.deepEqual(await charges(), { SAMSCLUB: 'business', SAMS: null, SHELL: null });

  await post('/api/tax/rules', { field: 'store_card', value: 'samsclub', status: 'business' });
  const { rules } = await get('/api/tax/rules');
  assert.deepEqual(rules.map((r) => [r.field, r.value, r.status]), [['store_card', 'samsclub', 'personal']], 'always personal');

  // S3's card isn't known, so it's left to review; other stores aren't touched.
  assert.deepEqual(await items(), { S1: 'business', S2: 'personal', S3: 'unreviewed', W1: 'unreviewed' });
  assert.deepEqual(await charges(), { SAMSCLUB: 'business', SAMS: 'personal', SHELL: null });
});

test("the dashboard leaves out what's personal", async () => {
  const report = await get('/api/report?status=notpersonal');
  assert.equal(report.totals.spend, 80 + 12 + 15, 'S2 is left out');
  assert.equal(report.totals.orders, 3);
  const all = await get('/api/report');
  assert.equal(all.totals.spend, 80 + 30 + 12 + 15, 'still there without the filter');

  const spending = await get('/api/bank/spending?status=notpersonal');
  assert.equal(spending.byStore.find((s) => s.key === "Sam's Club")?.spend, 45, "the personal card's Sam's Club charge is left out");
  const totals = await get('/api/bank/transactions?status=notpersonal&limit=1');
  assert.equal(totals.moneyOut, 55);
});

test('removing the rule puts things back', async () => {
  const { rules } = await get('/api/tax/rules');
  await post('/api/tax/rules/delete', { id: rules[0].id });
  assert.deepEqual(await items(), { S1: 'unreviewed', S2: 'unreviewed', S3: 'unreviewed', W1: 'unreviewed' });
  assert.deepEqual(await charges(), { SAMSCLUB: 'business', SAMS: null, SHELL: null });
});

test('a rule with several conditions needs them all, and beats a simpler rule', async () => {
  await post('/api/tax/rules', { field: 'store', value: 'samsclub', status: 'personal' });
  await post('/api/tax/rules', {
    field: 'multi',
    status: 'business',
    conditions: [
      { field: 'store', value: 'samsclub' },
      { field: 'payment', value: 'Card ending 9999', not: true },
    ],
  });
  // Saving it again, conditions in another order, changes nothing.
  await post('/api/tax/rules', {
    field: 'multi',
    status: 'business',
    conditions: [
      { field: 'payment', value: 'Card ending 9999', not: true },
      { field: 'store', value: 'samsclub' },
    ],
  });
  assert.equal((await get('/api/tax/rules')).rules.length, 2);
  // W1 was paid with the same card but at another store.
  assert.deepEqual(await items(), { S1: 'business', S2: 'personal', S3: 'business', W1: 'unreviewed' });

  // Two places at once: any of a field's values matches.
  await post('/api/tax/rules', {
    field: 'multi',
    status: 'personal',
    conditions: [
      { field: 'store', value: 'walmart' },
      { field: 'payment', value: 'Card ending 9999' },
      { field: 'payment', value: 'Card ending 0000' },
    ],
  });
  assert.equal((await items()).W1, 'personal');

  await assert.rejects(post('/api/tax/rules', { field: 'multi', status: 'business', conditions: [{ field: 'store', value: 'samsclub' }] }), { status: 400 });
  await assert.rejects(post('/api/tax/rules', { field: 'multi', status: 'business', conditions: [{ field: 'store', value: 'x' }, { field: 'nope', value: 'y' }] }), { status: 400 });
});

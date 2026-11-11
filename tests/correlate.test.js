// Phase 4: store orders matched to card charges, charges split by item, and
// spending assigned to businesses and properties.
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
const charge = async (q) => (await get(`/api/bank/transactions?preset=all&kind=all&q=${encodeURIComponent(q)}`)).transactions;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-correlate-'));
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

  // Orders, as the extension syncs them.
  const sync = (store, orders) =>
    fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ store, orders }) });
  await sync('amazon', [
    {
      orderId: 'A1',
      date: '2026-03-01',
      total: 54.2,
      payment: 'Visa ending 4321',
      deliveryZip: '01845',
      deliveryAddress: '45 Elm Street North Andover, MA 01845',
      items: [
        { name: 'Paper Towels', price: 30, quantity: 1 },
        { name: 'Dish Soap', price: 24.2, quantity: 1 },
      ],
    },
    // Charged as two shipments.
    { orderId: 'A2', date: '2026-03-05', total: 100, payment: 'Visa ending 4321', items: [{ name: 'Light Bulbs', price: 60, quantity: 1 }, { name: 'Kettle', price: 40, quantity: 1 }] },
  ]);
  // Paid with a different card than the one imported below.
  await sync('walmart', [{ orderId: 'W1', storeName: 'Walmart', date: '2026-03-10', total: 20, payment: 'Visa ending 1111', items: [{ name: 'Batteries', price: 20, quantity: 1 }] }]);

  // The card statement arrives afterwards; matching runs when it's imported.
  await post('/api/bank/import', {
    content: OFX(),
    fileName: 'card.qfx',
    newAccount: { name: 'Business Visa', kind: 'credit', owner: 'business' },
  });
});

function OFX() {
  const tx = [
    ['20260303', '-54.20', 'AMZN Mktp US*1A2B3C'],
    ['20260307', '-60.00', 'AMZN Mktp US*4D5E6F'],
    ['20260309', '-40.00', 'AMAZON.COM*7G8H9I'],
    ['20260311', '-20.00', 'WALMART.COM 8009256278'],
    ['20260312', '-40.00', 'SHELL OIL 57444'],
  ];
  return `OFXHEADER:100\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4111111111114321</CCACCTFROM><BANKTRANLIST>
${tx.map(([d, a, n], i) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d}<TRNAMT>${a}<FITID>T${i}<NAME>${n}</STMTTRN>`).join('\n')}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
}

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a charge is matched to its order, and takes its category from the items', async () => {
  const [tx] = await charge('1A2B3C');
  assert.deepEqual(tx.orders, [{ store: 'amazon', orderId: 'A1', amount: 54.2 }]);
  assert.equal(tx.category, 'Household Paper & Disposables', 'the category with the most money in the order');
  assert.equal(tx.categorySource, 'order');
  const { split } = await get(`/api/bank/transactions/${tx.id}/orders`);
  assert.deepEqual(
    split.map((l) => [l.category, l.amount]),
    [
      ['Household Paper & Disposables', 30],
      ['Cleaning Supplies', 24.2],
    ]
  );
});

test('an order charged as two shipments is matched to both charges', async () => {
  const parts = [...(await charge('4D5E6F')), ...(await charge('7G8H9I'))];
  assert.deepEqual(parts.map((t) => t.orders[0]?.orderId), ['A2', 'A2']);
  // Each charge pays its share of the order's items.
  const { split } = await get(`/api/bank/transactions/${parts[0].id}/orders`);
  assert.deepEqual(split.map((l) => l.amount), [36, 24]);
  const { charges } = await get('/api/orders/amazon/A2/charges');
  assert.equal(charges.length, 2);
});

test('a charge on a different card is not matched; it can be linked by hand, and unlinked for good', async () => {
  const [walmart] = await charge('WALMART');
  assert.deepEqual(walmart.orders, []);
  const unmatched = await get('/api/bank/transactions?preset=all&unmatched=1');
  assert.deepEqual(unmatched.transactions.map((t) => t.payee), ['Walmart']);

  const { suggestions } = await get(`/api/bank/transactions/${walmart.id}/orders`);
  assert.equal(suggestions[0].orderId, 'W1');
  assert.equal(suggestions[0].exact, true);
  await post(`/api/bank/transactions/${walmart.id}/orders/link`, { store: 'walmart', orderId: 'W1' });
  assert.equal((await charge('WALMART'))[0].orders[0].orderId, 'W1');

  await post(`/api/bank/transactions/${walmart.id}/orders/unlink`, { store: 'walmart', orderId: 'W1' });
  await post('/api/bank/match-orders');
  assert.deepEqual((await charge('WALMART'))[0].orders, [], 'not linked again on its own');
});

test('changing an item category re-splits the charge', async () => {
  await post('/api/items/category', { name: 'Paper Towels', category: 'Cleaning Supplies' });
  const [tx] = await charge('1A2B3C');
  assert.equal(tx.category, 'Cleaning Supplies');
  const { split } = await get(`/api/bank/transactions/${tx.id}/orders`);
  assert.deepEqual(split.map((l) => [l.category, l.amount]), [['Cleaning Supplies', 54.2]]);
});

test('entities: from the delivery place, the account, a rule, or shared by hand', async () => {
  const { id: rental } = await post('/api/entities', { name: 'Elm St rental', kind: 'rental' });
  const { id: consulting } = await post('/api/entities', { name: 'Consulting LLC', kind: 'business' });
  await assert.rejects(post('/api/entities', { name: 'elm st rental', kind: 'rental' }), /already one/);

  // The account belongs to the consulting business...
  const account = (await get('/api/bank/accounts')).accounts[0];
  await post(`/api/bank/accounts/${account.id}`, { entityId: consulting });
  let [shell] = await charge('SHELL');
  assert.deepEqual([shell.entityId, shell.entitySource], [consulting, 'account']);

  // ...but things delivered to the rental belong to it.
  await post('/api/places/entity', { zip: '01845', entityId: rental });
  const [delivered] = await charge('1A2B3C');
  assert.deepEqual([delivered.entityId, delivered.entitySource], [rental, 'place']);

  // A rule can share a cost equally.
  await post('/api/bank/rules', { pattern: 'SHELL', sharedEntities: [rental, consulting] });
  [shell] = await charge('SHELL');
  assert.deepEqual([shell.entityId, shell.entitySource], [null, 'rule']);
  assert.deepEqual(shell.shares.map((s) => s.percent), [50, 50]);

  // The user's own split wins.
  await post('/api/bank/transactions/update', { ids: [shell.id], shares: [{ entityId: rental, percent: 25 }, { entityId: consulting, percent: 75 }] });
  [shell] = await charge('SHELL');
  assert.deepEqual(shell.shares.sort((a, b) => a.percent - b.percent).map((s) => [s.entityId, s.percent]), [[rental, 25], [consulting, 75]]);
  await assert.rejects(post('/api/bank/transactions/update', { ids: [shell.id], shares: [{ entityId: rental, percent: 50 }, { entityId: consulting, percent: 40 }] }), /add up to 100/);

  const spending = await get('/api/bank/spending?preset=all');
  const byEntity = Object.fromEntries(spending.byEntity.map((e) => [e.label, e.spend]));
  // Rental: the delivered order (54.20) + a quarter of the fuel (10). Consulting: the rest.
  assert.equal(byEntity['Elm St rental'], 64.2);
  assert.equal(byEntity['Consulting LLC'], 150);
  assert.equal(spending.totals.spend, 214.2);
  const byCategory = Object.fromEntries(spending.byCategory.map((c) => [c.label, c.spend]));
  assert.equal(byCategory['Kitchen & Dining'], 40, 'the kettle, from the two shipments');

  // Filtering by entity finds shared ones too.
  assert.equal((await get(`/api/bank/transactions?preset=all&entity=${rental}`)).total, 2);
  assert.equal((await get('/api/bank/transactions?preset=all&entity=none')).total, 0);

  // Removing an entity leaves its spending unassigned, and rules without it.
  await post(`/api/entities/${rental}/delete`);
  [shell] = await charge('SHELL');
  assert.deepEqual(shell.shares.map((s) => s.entityId), [consulting], 'the user split keeps the rest');
  const rule = (await get('/api/bank/rules')).rules[0];
  assert.equal(rule.sharedEntities, null);
  assert.equal(rule.entityId, consulting);
});

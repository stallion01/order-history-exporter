// Tests the database and its API against a real server with a temporary database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

const OHE = require('../server/core');
const { openDatabase, SCHEMA_V1, cityFromAddress, zip5 } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { isPrivateAddress } = require('../server/dist/security');
const { createClassifier } = require('../server/categories');
const { allocate } = require('../server/tax');

const TOKEN = 'test-token';
let dir;
let db;
let app;
let base;
let cookie;

// Calls the API as the signed-in owner, as the web app does.
const call = (route, options = {}) =>
  fetch(`${base}${route}`, {
    ...options,
    headers: {
      cookie,
      'x-requested-with': 'expense-hub',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
const post = async (route, body) => (await call(route, { method: 'POST', body: JSON.stringify(body) })).json();
const get = async (route) => (await call(route)).json();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohe-test-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => TOKEN, rotate: () => TOKEN }, allowedHosts: (host) => host.startsWith('127.0.0.1:') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: TOKEN, username: 'owner', password: 'a long test password' }),
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planGaps reads only what was never read, plus a recent re-check', () => {
  const today = '2026-11-07';
  assert.deepEqual(OHE.planGaps({ from: '2024-01-01', to: '2024-12-31' }, [], today), [{ from: '2024-01-01', to: '2024-12-31' }]);
  assert.deepEqual(OHE.planGaps({ from: '2024-01-01', to: '2024-12-31' }, [{ from: '2024-01-01', to: '2024-12-31' }], today), []);
  assert.deepEqual(
    OHE.planGaps({ from: '2023-01-01', to: '2025-12-31' }, [{ from: '2024-01-01', to: '2024-12-31' }], today),
    [{ from: '2025-01-01', to: '2025-12-31' }, { from: '2023-01-01', to: '2023-12-31' }]
  );
  assert.deepEqual(OHE.planGaps({ from: '2026-01-01', to: today }, [{ from: '2026-01-01', to: today }], today), [{ from: '2026-09-08', to: today }]);
  assert.deepEqual(OHE.planGaps({ from: null, to: null }, [{ from: '0001-01-01', to: '2026-01-01' }], today), [
    { from: '2026-01-02', to: today },
  ]);
  assert.deepEqual(OHE.planGaps({ from: null, to: null }, [], today), [{ from: null, to: today }]);
});

test('shiftDay crosses leap days and year ends', () => {
  assert.equal(OHE.shiftDay('2023-02-28', 1), '2023-03-01');
  assert.equal(OHE.shiftDay('2024-02-28', 1), '2024-02-29');
  assert.equal(OHE.shiftDay('2024-01-01', -1), '2023-12-31');
  assert.equal(OHE.shiftDay('0001-01-01', 1), '0001-01-02');
});

test('mergeRanges joins overlapping and touching ranges only', () => {
  assert.deepEqual(
    OHE.mergeRanges([
      { from: '2024-03-01', to: '2024-04-01' },
      { from: '2024-01-01', to: '2024-02-29' },
      { from: '2024-06-01', to: '2024-07-01' },
    ]),
    [{ from: '2024-01-01', to: '2024-04-01' }, { from: '2024-06-01', to: '2024-07-01' }]
  );
});

test('reports need a session, the token only syncs, and only allowed addresses answer', async () => {
  const bearer = (value) => ({ headers: { Authorization: `Bearer ${value}` } });
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/export.csv`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, bearer(TOKEN))).status, 403, 'the extension token cannot read reports');
  assert.equal((await fetch(`${base}/api/settings/token`, bearer(TOKEN))).status, 403);
  assert.equal((await fetch(`${base}/api/health`, bearer(TOKEN))).status, 200);
  assert.equal((await fetch(`${base}/api/sync/plan?store=amazon`, bearer(TOKEN))).status, 200);
  assert.equal((await fetch(`${base}/api/health`, bearer('wrong'))).status, 401);
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  assert.equal((await call('/api/status')).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 503, 'no web app is built into this test server');

  // A signed-in change without the app's header is refused, so other sites can't forge one.
  const forged = await fetch(`${base}/api/tax/rules`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ field: 'zip', value: '1', status: 'business' }),
  });
  assert.equal(forged.status, 403);

  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/health`, { headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('rejects bad input, and search text cannot alter the query', async () => {
  assert.equal((await call('/api/report?from=not-a-date')).status, 400);
  assert.equal((await call('/api/sync/plan?store=bad%20store')).status, 400);
  assert.equal((await call('/api/orders', { method: 'POST', body: '{nope' })).status, 400);
  const injected = await get(`/api/orders?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(injected.total, 0);
  const traversal = await call('/../db.js');
  assert.notEqual(traversal.status, 200);
  assert.ok(!(await traversal.text()).includes('openDatabase'), 'server files are never served');
});

test('saving keeps known values, and list pages do not thin out detailed items', async () => {
  const first = await post('/api/orders', {
    store: 'amazon',
    orders: [
      { orderId: 'A1', storeName: 'Amazon', date: '2024-03-01', total: 30, status: 'Shipped', fromList: true, detailUrl: 'https://www.amazon.com/d/A1', items: [{ name: 'Kettle' }] },
    ],
  });
  assert.deepEqual(first, { inserted: 1, updated: 0 });

  const detail = await post('/api/orders', {
    store: 'amazon',
    orders: [{ orderId: 'A1', detailRead: true, tax: 2.5, payment: 'Visa ending 1234', deliveryZip: '02134', items: [{ name: 'Kettle', price: 27.5, quantity: 1 }] }],
  });
  assert.deepEqual(detail, { inserted: 0, updated: 1 });

  const reread = await post('/api/orders', {
    store: 'amazon',
    orders: [{ orderId: 'A1', date: '2024-03-01', total: 30, status: 'Shipped', fromList: true, items: [{ name: 'Kettle' }] }],
  });
  assert.deepEqual(reread, { inserted: 0, updated: 0 }, 'an identical re-read changes nothing');

  const [order] = (await get('/api/orders?store=amazon')).orders;
  assert.equal(order.tax, 2.5);
  assert.equal(order.payment, 'Visa ending 1234');
  assert.equal(order.deliveryZip, '02134', 'leading zero kept');
  assert.equal(order.items[0].price, 27.5);
  assert.equal(order.detailRead, true);
});

test('a details total survives re-checks, until the list itself changes', async () => {
  const listed = { orderId: 'D1', date: '2024-02-02', total: 45.1, status: 'Delivered', fromList: true };
  await post('/api/orders', { store: 'newegg', orders: [listed] });
  await post('/api/orders', { store: 'newegg', orders: [{ orderId: 'D1', detailRead: true, total: 48.2 }] });

  assert.deepEqual(await post('/api/orders', { store: 'newegg', orders: [listed] }), { inserted: 0, updated: 0 });
  assert.equal((await get('/api/orders?q=D1')).orders[0].total, 48.2);

  const returned = await post('/api/orders', { store: 'newegg', orders: [{ ...listed, status: 'Returned', total: 0 }] });
  assert.deepEqual(returned, { inserted: 0, updated: 1 });
  const [order] = (await get('/api/orders?q=D1')).orders;
  assert.equal(order.status, 'Returned');
  assert.equal(order.total, 0, 'a zero total is a real value');
});

test('sync plan skips fully read ranges and lists only missing details', async () => {
  await post('/api/orders', {
    store: 'walmart',
    orders: [
      { orderId: 'W1', date: '2024-05-01', total: 10, fromList: true, detailUrl: 'https://www.walmart.com/orders/W1' },
      { orderId: 'W2', date: '2024-06-01', total: 20, fromList: true, detailUrl: 'https://www.walmart.com/orders/W2' },
      { orderId: 'W3', date: '2019-06-01', total: 5, fromList: true, detailUrl: 'https://www.walmart.com/orders/W3' },
    ],
  });
  await post('/api/orders', { store: 'walmart', orders: [{ orderId: 'W1', detailRead: true, tax: 1 }] });
  await post('/api/sync/coverage', { store: 'walmart', ranges: [{ from: '2024-01-01', to: '2024-12-31' }] });

  const range = '&from=2024-01-01&to=2024-12-31';
  const plan = await get(`/api/sync/plan?store=walmart${range}`);
  assert.deepEqual(plan.gaps, [], 'nothing to list again');
  assert.deepEqual(plan.pendingDetails.map((o) => o.orderId), ['W2'], 'only the in-range order missing details');
  assert.equal(plan.known.W1.detailDone, true);
  assert.equal(plan.known.W2.detailDone, false);

  const full = await get(`/api/sync/plan?store=walmart${range}&full=1`);
  assert.equal(full.gaps.length, 1);
  assert.deepEqual(full.known, {});
  assert.deepEqual(full.pendingDetails.map((o) => o.orderId).sort(), ['W1', 'W2']);
});

test('an order that keeps failing stops being retried', async () => {
  const fail = () => post('/api/orders', { store: 'ebay', orders: [{ orderId: 'E1', detailFailed: true }] });
  await post('/api/orders', { store: 'ebay', orders: [{ orderId: 'E1', date: '2024-01-01', fromList: true, detailUrl: 'https://order.ebay.com/1' }] });
  await fail();
  await fail();
  assert.equal((await get('/api/sync/plan?store=ebay')).pendingDetails.length, 1);
  await fail();
  assert.equal((await get('/api/sync/plan?store=ebay')).pendingDetails.length, 0);
});

test('report totals, filters, and CSV come from the database', async () => {
  await post('/api/orders', {
    store: 'homedepot',
    orders: [
      { orderId: 'H1', storeName: 'Home Depot', date: '2025-01-10', total: 100, tax: 7, payment: 'Visa ending 1234', deliveryZip: '02134', items: [{ name: '=Paint', quantity: 2 }] },
      { orderId: 'H2', storeName: 'Home Depot', date: '2025-03-10', total: -40, payment: 'Visa ending 1234', items: [{ name: 'Returned Saw' }] },
      { orderId: 'H3', storeName: 'Home Depot', date: '2025-03-12', total: 0, items: [{ name: 'Free Sample' }] },
    ],
  });
  const report = await get('/api/report?store=homedepot');
  assert.equal(report.totals.orders, 3);
  assert.equal(report.totals.spend, 60, 'returns reduce spending');
  // Each row carries the filter value that lists its orders, for the dashboard's links.
  assert.equal(report.byStore[0].key, 'homedepot');
  const unrecorded = report.byPayment.find((row) => row.label === 'Not recorded');
  assert.equal(unrecorded.key, 'none');
  assert.equal((await get('/api/orders?store=homedepot&payment=none')).total, 1);
  assert.equal(report.totals.tax, 7);
  assert.equal(report.totals.items, 4);
  assert.deepEqual(report.byMonth.map((m) => m.label), ['2025-01', '2025-03']);
  assert.equal(report.byPayment[0].label, 'Visa ending 1234');
  assert.equal(report.byZip[0].label, '02134');

  assert.equal((await get('/api/orders?q=saw')).total, 1);
  assert.equal((await get('/api/orders?q=%25')).total, 0, 'a % is searched for literally');
  assert.equal((await get('/api/report?store=homedepot&from=2025-02-01')).totals.orders, 2);

  const response = await call('/api/export.csv?store=homedepot&layout=items');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const csv = await response.text();
  assert.ok(csv.includes('Order Date'));
  assert.ok(csv.includes("'=Paint"), 'formula text stays neutralised');
  assert.ok(csv.includes(',02134,'), 'ZIP intact');
  assert.equal((await (await call('/api/export.csv?store=homedepot&layout=orders')).text()).trim().split('\r\n').length, 4);
});

test('city names are read from one-line delivery addresses', () => {
  const cases = {
    '12 Oak Road Apt 4 Bentonville, AR 72712': 'Bentonville, AR',
    'PO Box 9 Boston, MA 02134': 'Boston, MA',
    '12 Court St Boston, MA 02108': 'Boston, MA',
    '45 ELM STREET NORTH ANDOVER, MA 01845-1234': 'North Andover, MA',
    '9 Main St N Fargo, ND 58102': 'Fargo, ND',
    '100 Main St, Springfield, IL 62701': 'Springfield, IL',
    '7 Harbor Way #12 Cape Coral, FL 33904': 'Cape Coral, FL',
    '12 Oak Road Apt 4 Boston,MA 02134-1234': 'Boston, MA',
    '1 Broadway Cambridge, MA 02142': null, // no way to tell street from city
    'somewhere without a state': null,
  };
  for (const [address, city] of Object.entries(cases)) assert.equal(cityFromAddress(address), city, address);
  assert.deepEqual([zip5('02134-1234'), zip5('021341234'), zip5('02134'), zip5('K1A 0B1')], ['02134', '02134', '02134', 'K1A 0B1']);
});

test('ZIP+4 is kept as five digits, and spending is shown by city', async () => {
  await post('/api/orders', {
    store: 'placemart',
    orders: [
      { orderId: 'P1', storeName: 'Place Mart', date: '2026-05-01', total: 10, deliveryZip: '01845-1234', deliveryAddress: '45 Elm Street North Andover, MA 01845-1234' },
      { orderId: 'P2', storeName: 'Place Mart', date: '2026-05-02', total: 20, deliveryZip: '01845', deliveryAddress: '45 Elm Street North Andover, MA 01845' },
      { orderId: 'P3', storeName: 'Place Mart', date: '2026-05-03', total: 5, deliveryZip: '01810-0001', deliveryAddress: '9 Main St Andover, MA 01810-0001' },
      { orderId: 'P4', storeName: 'Place Mart', date: '2026-05-04', total: 7, deliveryZip: '01810', deliveryAddress: '1 Broadway Andover, MA 01810' },
    ],
  });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE delivery_zip LIKE '%-%'").get().n, 0);
  assert.equal((await get('/api/orders?store=placemart&zip=01845-9999')).total, 2, 'a ZIP+4 filter matches its ZIP');

  const report = await get('/api/report?store=placemart');
  assert.deepEqual(report.byCity.map((c) => [c.label, c.spend, c.keys]), [
    ['North Andover, MA', 30, ['01845']],
    ['Andover, MA', 12, ['01810']],
  ]);
  const meta = await get('/api/status');
  assert.equal(meta.places.find((p) => p.zip === '01845').label, 'North Andover, MA');

  // A name given by the user wins, and two ZIPs given the same name are one place.
  await post('/api/places', { zip: '01845', name: 'Elm St rental' });
  await post('/api/places', { zip: '01810', name: 'Elm St rental' });
  const named = await get('/api/report?store=placemart');
  assert.deepEqual(named.byCity.map((c) => [c.label, c.spend, c.keys]), [['Elm St rental', 42, ['01810', '01845']]]);
  await post('/api/places', { zip: '01845', name: '' });
  await post('/api/places', { zip: '01810', name: '' });
  assert.equal((await get('/api/places')).places.find((p) => p.zip === '01845').label, 'North Andover, MA');
});

test('filters take several values each, and any of them matches', async () => {
  await post('/api/orders', {
    store: 'multimart',
    orders: [
      { orderId: 'W1', storeName: 'Multi Mart', date: '2024-06-01', total: 30, payment: 'Amex ending 9876', items: [{ name: 'Paper Towels' }] },
      { orderId: 'W2', storeName: 'Multi Mart', date: '2026-02-01', total: 50, payment: 'Visa ending 1234', items: [{ name: 'Bath Towels' }] },
    ],
  });
  const orders = async (query) => (await get(`/api/orders?${query}`)).total;
  assert.equal(await orders('store=homedepot&store=multimart'), 5);
  assert.equal(await orders('store=multimart&years=2024&years=2026'), 2);
  assert.equal(await orders('store=homedepot&store=multimart&years=2025'), 3);
  assert.equal(await orders('store=homedepot&store=multimart&years=2024&years=2025&from=2025-02-01'), 2, 'years and dates both apply');
  assert.equal(await orders('store=homedepot&store=multimart&payment=Amex%20ending%209876&payment=none'), 2, 'a method or none recorded');
  assert.equal(await orders('store=multimart&payment=Visa%20ending%201234&payment=Amex%20ending%209876'), 2);

  const report = await get('/api/report?store=homedepot&store=multimart&years=2024&years=2026');
  assert.equal(report.totals.orders, 2);
  assert.equal(report.totals.spend, 80);

  const categories = (await get('/api/items?store=multimart')).items.map((item) => item.category);
  const both = (await get(`/api/items?store=multimart&${categories.map((c) => `category=${encodeURIComponent(c)}`).join('&')}`)).total;
  assert.equal(both, 2);
  assert.equal((await call('/api/orders?years=20x6')).status, 400);
  assert.equal((await call('/api/orders?store=multimart&store=bad%20store')).status, 400);

  // Bulk marking by filters keeps every value of a list.
  const marked = await post('/api/items/status', { status: 'personal', filters: { store: ['multimart'], years: ['2024', '2026'] } });
  assert.equal(marked.changed, 2);
  await post('/api/items/status', { status: null, filters: { store: ['multimart'] } });
});

test('categories: rules, phrases beating single words, and store hints', () => {
  const classify = createClassifier([]);
  const category = (name, store) => classify(name, store).category;
  assert.equal(category('Tide Laundry Detergent Pods 112 ct'), 'Cleaning Supplies');
  assert.equal(category('Dawn Dish Soap 3 Pack'), 'Cleaning Supplies');
  assert.equal(category('Dove Hand Soap'), 'Bath & Personal Care');
  assert.equal(category('Bounty Paper Towels, 12 Rolls'), 'Household Paper & Disposables');
  assert.equal(category('Luxury Bath Towels Set of 6'), 'Linens & Bedding');
  assert.equal(category('Queen Sheet Set, White'), 'Linens & Bedding');
  assert.equal(category("Member's Mark Whole Milk 1 Gallon"), 'Grocery');
  assert.equal(category('Unleaded Fuel'), 'Automotive & Fuel');
  assert.equal(category('Purina Dog Food 40 lb'), 'Pet Supplies');
  assert.equal(category('Graphics Card 16GB'), 'Electronics & Computers');
  assert.equal(category('1/2 in. PVC Schedule 40 Conduit'), 'Building & Repair Materials');
  assert.equal(category('Husky Ratchet Tie Down'), 'Tools & Hardware');
  assert.equal(category('Xyzzy Widget', 'newegg'), 'Electronics & Computers');
  assert.equal(classify('Xyzzy Widget', 'newegg').source, 'store');
  assert.equal(category('Xyzzy Widget', 'amazon'), 'Uncategorized');
  // Parts of words don't count: "cat" is not in "catalog", nor "tea" in "steak".
  assert.equal(category('Holiday Catalog Steak Knives Display'), 'Uncategorized');
});

test('categories: corrections apply exactly, then teach similar names', () => {
  const classify = createClassifier([
    { name: 'Acme Glow Sparkle Spray', category: 'Cleaning Supplies' },
    { name: 'Acme Sparkle Refill', category: 'Cleaning Supplies' },
    { name: 'Single Mention Thing', category: 'Grocery' },
  ]);
  assert.deepEqual(classify('ACME glow sparkle spray'), { category: 'Cleaning Supplies', source: 'you' });
  assert.deepEqual(classify('Sparkle Lemon Concentrate'), { category: 'Cleaning Supplies', source: 'learned' });
  assert.equal(classify('Another Mention').source, 'none', 'one correction is not enough evidence');
  // A correction beats a rule for that item.
  const fixed = createClassifier([{ name: 'Whole Milk', category: 'Pet Supplies' }]);
  assert.equal(fixed('Whole Milk').category, 'Pet Supplies');
  assert.equal(fixed('Skim Milk').category, 'Grocery');
});

test('allocate shares the total across items, including tax and shipping', () => {
  const sum = (shares) => Math.round(shares.reduce((acc, s) => acc + s.amount, 0) * 100) / 100;
  const priced = allocate({ total: 110 }, [{ price: 10, quantity: 2 }, { price: 80, quantity: 1 }]);
  assert.deepEqual(priced.map((s) => s.amount), [22, 88]);
  assert.equal(priced[0].estimated, false);

  const lineTotals = allocate({ total: 54 }, [{ price: 10.5, quantity: 2, line_total: 21 }, { price: 3.12, quantity: 10.5, line_total: 33 }]);
  assert.deepEqual(lineTotals.map((s) => s.amount), [21, 33], 'a line total beats price times quantity');

  const thirds = allocate({ total: 10 }, [{ price: 1 }, { price: 1 }, { price: 1 }]);
  assert.equal(sum(thirds), 10, 'rounding never loses a cent');

  const even = allocate({ total: 30 }, [{ name: 'a' }, { name: 'b' }, { name: 'c', price: 5 }]);
  assert.deepEqual(even.map((s) => s.amount), [10, 10, 10]);
  assert.equal(even[0].estimated, true);

  assert.deepEqual(allocate({ total: 9 }, [{ name: 'a' }]), [{ amount: 9, estimated: false }], 'one item is the whole order');
  assert.deepEqual(allocate({ total: -40 }, [{ price: 40 }, { price: 40 }]).map((s) => s.amount), [-20, -20], 'returns stay negative');
  assert.deepEqual(allocate({ total: null }, [{ price: 4, quantity: 2 }, { name: 'x' }]).map((s) => s.amount), [8, null]);
  assert.deepEqual(allocate({ total: 5 }, []), []);
});

test('private address check lets in local networks only', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.1', '169.254.1.1', '100.64.0.1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '11.0.0.1', '100.128.0.1', '2001:4860::1', '', 'nonsense', undefined]) {
    assert.equal(isPrivateAddress(ip), false, String(ip));
  }
});

test('network mode: reachable by LAN address, and public clients refused', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  const netDb = openDatabase(path.join(dir, 'net.db'));
  const net = buildApp({ db: netDb, tokens: { get: () => TOKEN, rotate: () => TOKEN }, allowedHosts: () => true });
  await net.listen({ port: 0, host: '0.0.0.0' });
  const { port } = net.server.address();
  try {
    if (lan && isPrivateAddress(lan.address)) {
      const response = await fetch(`http://${lan.address}:${port}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 200);
      assert.equal((await fetch(`http://${lan.address}:${port}/api/health`)).status, 401, 'network mode still needs the token');
    }
    // A public address is refused, even with the right token.
    const refused = await net.inject({ method: 'GET', url: '/api/health', remoteAddress: '8.8.8.8', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(refused.statusCode, 403);
    // A proxy elsewhere can't pretend the request came from this network.
    const spoofed = await net.inject({ method: 'GET', url: '/api/health', remoteAddress: '8.8.8.8', headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '192.168.1.5' } });
    assert.equal(spoofed.statusCode, 403);
    // A proxy on this machine, such as Tailscale's, is trusted to pass on the client.
    const proxied = await net.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '100.101.102.103' } });
    assert.equal(proxied.statusCode, 200);
  } finally {
    await net.close();
    netDb.close();
  }
});

test('category correction and marks survive re-reads, and rules decide status', async () => {
  const body = (orderId, zip, payment, items, total = 100) => ({ orderId, storeName: 'Tax Store', date: '2024-07-01', total, deliveryZip: zip, payment, items });
  await post('/api/orders', {
    store: 'taxstore',
    orders: [
      body('R1', '11111', 'Visa ending 1111', [{ name: 'Bleach Cleaner', price: 60 }, { name: 'Bath Towels', price: 40 }]),
      body('R2', '22222', 'Visa ending 2222', [{ name: 'Whole Milk', price: 100 }]),
      body('R3', '11111', 'Visa ending 2222', [{ name: 'Whole Milk', price: 50 }, { name: 'New Sofa', price: 3000 }], 3050),
    ],
  });
  const items = async (query = '') => (await get(`/api/items?store=taxstore&limit=200${query}`)).items;
  const find = (rows, order, name) => rows.find((i) => i.orderId === order && i.name === name);

  let rows = await items();
  assert.equal(find(rows, 'R1', 'Bleach Cleaner').category, 'Cleaning Supplies');
  assert.equal(find(rows, 'R1', 'Bleach Cleaner').amount, 60);
  assert.equal(find(rows, 'R1', 'Bleach Cleaner').status, 'unreviewed');

  // Rules: a ZIP is business, but groceries stay personal even there.
  await post('/api/tax/rules', { field: 'zip', value: '11111', status: 'business' });
  await post('/api/tax/rules', { field: 'category', value: 'Grocery', status: 'personal' });
  rows = await items();
  assert.equal(find(rows, 'R1', 'Bleach Cleaner').status, 'business');
  assert.equal(find(rows, 'R3', 'Whole Milk').status, 'personal');
  assert.equal(find(rows, 'R2', 'Whole Milk').status, 'personal');

  // An item's own mark beats the rules, and survives its order being re-read.
  await post('/api/items/status', { status: 'personal', items: [{ store: 'taxstore', orderId: 'R1', name: 'Bath Towels' }] });
  await post('/api/orders', { store: 'taxstore', orders: [{ orderId: 'R1', detailRead: true, items: [{ name: 'Bleach Cleaner', price: 60 }, { name: 'Bath Towels', price: 40 }] }] });
  rows = await items();
  assert.equal(find(rows, 'R1', 'Bath Towels').status, 'personal');
  assert.equal(find(rows, 'R1', 'Bath Towels').statusSource, 'you');

  // Correcting one item's category applies to every item with that name.
  await post('/api/items/category', { name: 'Whole Milk', category: 'Cleaning Supplies' });
  rows = await items();
  assert.equal(find(rows, 'R2', 'Whole Milk').category, 'Cleaning Supplies');
  assert.equal(find(rows, 'R2', 'Whole Milk').categorySource, 'you');
  await post('/api/items/category', { name: 'Whole Milk', category: null });
  assert.equal(find(await items(), 'R2', 'Whole Milk').category, 'Grocery', 'a correction can be undone');
  assert.equal((await call('/api/items/category', { method: 'POST', body: JSON.stringify({ name: 'x', category: 'Nope' }) })).status, 400);

  // Sorting and filtering.
  const byAmount = await items('&sort=amount&dir=desc');
  assert.equal(byAmount[0].name, 'New Sofa');
  const byZip = await items('&sort=zip&dir=asc');
  assert.equal(byZip[0].deliveryZip, '11111');
  assert.equal(byZip[byZip.length - 1].deliveryZip, '22222');
  assert.equal((await items('&zip=22222')).length, 1);
  assert.equal((await items('&category=Grocery')).length, 2);
  assert.equal((await items('&status=business')).length, 2);
  const zipOrders = await get('/api/orders?store=taxstore&sort=zip&dir=desc');
  assert.equal(zipOrders.orders[0].deliveryZip, '22222');
  assert.equal(zipOrders.orders[0].items[0].category, 'Grocery');
  assert.equal((await get('/api/orders?store=taxstore&sort=x;DROP TABLE orders')).total, 3, 'an unknown sort is ignored');

  // Report figures follow the category filter.
  const report = await get('/api/report?store=taxstore');
  assert.equal(report.byCategory.find((c) => c.label === 'Cleaning Supplies').spend, 60);
  const groceryReport = await get('/api/report?store=taxstore&category=Grocery');
  assert.equal(groceryReport.totals.spend, 150);
  assert.equal(groceryReport.totals.orders, 2);

  // The tax report only contains business items, on the right form's lines.
  const c = await get('/api/tax/report?form=schedule-c&year=2024');
  assert.deepEqual(c.lines.map((l) => [l.line, l.amount]), [['22', 60], ['27b', 3000]]);
  assert.equal(c.totals.business, 3060);
  assert.equal(c.totals.personal, 190);
  assert.equal(c.review.length, 1, 'a large item is flagged');
  assert.equal(c.review[0].name, 'New Sofa');
  const e = await get('/api/tax/report?form=schedule-e&year=2024');
  assert.deepEqual(e.lines.map((l) => [l.line, l.amount]), [['7', 60], ['19', 3000]]);
  assert.equal((await get('/api/tax/report?form=schedule-c&year=2019')).totals.businessItems, 0);
  assert.equal((await call('/api/tax/report?form=form-999')).status, 400);

  // A category with no line is reported, not silently dropped.
  await post('/api/items/status', { status: 'business', items: [{ store: 'taxstore', orderId: 'R2', name: 'Whole Milk' }] });
  const withGrocery = await get('/api/tax/report?form=schedule-c&year=2024');
  assert.deepEqual(withGrocery.unassigned.map((u) => [u.category, u.amount]), [['Grocery', 100]]);
  await post('/api/categories', { name: 'Grocery', scheduleC: '24b', scheduleE: null });
  const mapped = await get('/api/tax/report?form=schedule-c&year=2024');
  assert.deepEqual(mapped.unassigned, []);
  assert.match(mapped.lines.find((l) => l.line === '24b').note, /50%/);
  assert.equal((await call('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'X', scheduleC: '999' }) })).status, 400);

  // Marking everything that matches a filter.
  const bulk = await post('/api/items/status', { status: 'personal', filters: { store: 'taxstore', zip: '22222' } });
  assert.equal(bulk.changed, 1);

  // Exports.
  const summary = await (await call('/api/tax/export.csv?form=schedule-c&year=2024&detail=summary')).text();
  assert.ok(summary.startsWith('Tax Year,Form,Line'));
  assert.ok(summary.includes('2024,Schedule C,22,Supplies,60,1'));
  const detail = await (await call('/api/tax/export.csv?form=schedule-c&year=2024')).text();
  assert.ok(detail.includes('Bleach Cleaner'));
  assert.ok(!detail.includes('Bath Towels'), 'personal items are left out');
  assert.ok(detail.includes('Schedule C Line'));
  const itemsCsv = await (await call('/api/items.csv?store=taxstore&sort=zip&dir=asc')).text();
  assert.ok(itemsCsv.includes('Delivery ZIP'));
  assert.equal(itemsCsv.trim().split('\r\n').length, 6);
  const ordersCsv = await (await call('/api/export.csv?store=taxstore')).text();
  assert.ok(ordersCsv.includes('Category'));
  assert.ok(ordersCsv.includes('Cleaning Supplies'));

  const { rules } = await get('/api/tax/rules');
  for (const rule of rules) await post('/api/tax/rules/delete', { id: rule.id });
  assert.deepEqual((await get('/api/tax/rules')).rules, []);
  assert.equal((await call('/api/tax/rules', { method: 'POST', body: JSON.stringify({ field: 'password', value: 'x', status: 'business' }) })).status, 400);
});

test('upgrading an older database keeps its orders, backs it up, and queues missing details', () => {
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`${SCHEMA_V1} PRAGMA user_version = 1;`);
  const add = old.prepare("INSERT INTO orders (store, order_id, order_date, total, detail_url, detail_fetched_at, first_seen_at, updated_at) VALUES (?, ?, '2024-01-01', 5, 'https://x/y', '2024-02-02', 'a', 'a')");
  add.run('samsclub', 'NOPRICE');
  add.run('samsclub', 'PRICED');
  add.run('ebay', 'OTHER');
  old.prepare("INSERT INTO items (store, order_id, position, name) VALUES ('samsclub', 'NOPRICE', 0, 'Thing')").run();
  old.prepare("INSERT INTO items (store, order_id, position, name, price) VALUES ('samsclub', 'PRICED', 0, 'Thing', 5)").run();
  old.close();

  const upgraded = openDatabase(file);
  assert.equal(upgraded.listOrders({}).total, 3);
  assert.ok(fs.existsSync(`${file}.before-v14.bak`), 'a backup was made first');
  const pending = upgraded.syncPlan('samsclub', { from: null, to: null }).pendingDetails.map((o) => o.orderId);
  assert.deepEqual(pending, ['NOPRICE'], 'only orders missing prices are read again');
  assert.equal(upgraded.syncPlan('ebay', { from: null, to: null }).pendingDetails.length, 0);
  assert.ok(upgraded.categoryList().some((c) => c.name === 'Cleaning Supplies'));
  upgraded.close();

  const backup = new DatabaseSync(`${file}.before-v14.bak`, { readOnly: true });
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 3);
  backup.close();
});

test('upgrading to v8 trims ZIP+4 in orders and rules', () => {
  const file = path.join(dir, 'v7.db');
  const first = openDatabase(file);
  first.saveOrders('ebay', [{ orderId: 'Z', date: '2026-01-01' }]);
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE orders SET delivery_zip = '02134-1234'");
  raw.exec("INSERT INTO tax_rules (field, value, status) VALUES ('zip', '02134-1234', 'business')");
  raw.exec('DROP TABLE stay_conflicts; DROP TABLE stay_link_rejections; DROP TABLE stay_deposits; DROP TABLE stay_payout_lines; DROP TABLE stay_payouts; DROP TABLE stays; DROP TABLE stay_properties; ALTER TABLE receipts DROP COLUMN checked_by; DROP TABLE capital_reviews; DROP TABLE assets; ALTER TABLE categories DROP COLUMN expense_class; DROP TABLE order_link_rejections; DROP TABLE order_links; DROP TABLE place_entities; DROP TABLE tx_entity_shares; ALTER TABLE bank_transactions DROP COLUMN entity_source; ALTER TABLE bank_transactions DROP COLUMN entity_id; ALTER TABLE bank_rules DROP COLUMN shared_entities; ALTER TABLE bank_rules DROP COLUMN entity_id; ALTER TABLE bank_accounts DROP COLUMN entity_id; DROP TABLE entities; DROP TABLE zip_names; PRAGMA user_version = 7');
  raw.close();
  const second = openDatabase(file);
  assert.equal(second.raw.prepare('SELECT delivery_zip FROM orders').get().delivery_zip, '02134');
  assert.equal(second.raw.prepare("SELECT value FROM tax_rules WHERE field = 'zip'").get().value, '02134');
  second.close();
});

test('upgrading to v4 queues Amazon details to be read again', () => {
  const file = path.join(dir, 'v3.db');
  const first = openDatabase(file);
  first.saveOrders('amazon', [{ orderId: 'A', date: '2026-01-01', detailRead: true, items: [{ name: 'Kettle' }, { name: 'Suggested PC' }] }]);
  first.saveOrders('ebay', [{ orderId: 'E', date: '2026-01-01', detailRead: true }]);
  first.close();
  const raw = new DatabaseSync(file);
  // Back to how a version 3 database looked, without the later bank tables.
  raw.exec('DROP TABLE stay_conflicts; DROP TABLE stay_link_rejections; DROP TABLE stay_deposits; DROP TABLE stay_payout_lines; DROP TABLE stay_payouts; DROP TABLE stays; DROP TABLE stay_properties; ALTER TABLE receipts DROP COLUMN checked_by; DROP TABLE capital_reviews; DROP TABLE assets; ALTER TABLE categories DROP COLUMN expense_class; DROP TABLE order_link_rejections; DROP TABLE order_links; DROP TABLE place_entities; DROP TABLE tx_entity_shares; ALTER TABLE bank_transactions DROP COLUMN entity_source; ALTER TABLE bank_transactions DROP COLUMN entity_id; ALTER TABLE bank_rules DROP COLUMN shared_entities; ALTER TABLE bank_rules DROP COLUMN entity_id; ALTER TABLE bank_accounts DROP COLUMN entity_id; DROP TABLE entities; DROP TABLE zip_names; DROP TABLE receipts; DROP TABLE bank_import_rows; DROP TABLE bank_tx_sources; DROP TABLE bank_rules; DROP TABLE bank_imports; DROP TABLE bank_transactions; DROP TABLE bank_accounts; DROP TABLE csv_layouts; DROP TABLE app_settings;');
  raw.exec('PRAGMA user_version = 3');
  raw.close();
  const second = openDatabase(file);
  const pending = (store) => second.raw.prepare('SELECT detail_fetched_at FROM orders WHERE store = ?').get(store).detail_fetched_at;
  assert.equal(pending('amazon'), null);
  assert.ok(pending('ebay'), 'other stores are left alone');
  // The next details read replaces the items.
  second.saveOrders('amazon', [{ orderId: 'A', detailRead: true, items: [{ name: 'Kettle' }] }]);
  assert.equal(second.raw.prepare('SELECT COUNT(*) n FROM items WHERE order_id = ?').get('A').n, 1);
  second.close();
});

test('a new database file can be reopened, and keeps its data', () => {
  const file = path.join(dir, 'reopen.db');
  const first = openDatabase(file);
  first.saveOrders('amazon', [{ orderId: 'X', date: '2024-01-01' }]);
  first.close();
  const second = openDatabase(file);
  assert.equal(second.listOrders({}).total, 1);
  second.close();
});

// Fixtures are synthetic, so these tests check parsing logic against the expected
// page shape. They cannot prove a store's live pages still look that way.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SCRIPTS = [
  'src/lib/core.js',
  'src/lib/runner.js',
  'src/stores/index.js',
  'src/stores/amazon.js',
  'src/stores/walmart-family.js',
  'src/stores/walmart.js',
  'src/stores/samsclub.js',
  'src/stores/ebay.js',
  'src/stores/newegg.js',
  'src/stores/homedepot.js',
];

function load(html = '<!doctype html><body></body>', url = 'https://www.amazon.com/') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  for (const script of SCRIPTS) dom.window.eval(read(script));
  return dom.window;
}
const fixture = (name) => read(`tests/fixtures/${name}.html`);
// Objects from jsdom's realm fail strict equality on prototypes, so copy them across.
const plain = (value) => JSON.parse(JSON.stringify(value));

const CTX = { today: '2024-12-31', range: { from: '2024-01-01', to: '2024-12-31' } };
const { OHE } = load();

test('parseDate reads the formats stores use', () => {
  const today = '2024-06-15';
  assert.equal(OHE.parseDate('January 5, 2024', today), '2024-01-05');
  assert.equal(OHE.parseDate('Jan 05, 2023 order', today), '2023-01-05');
  assert.equal(OHE.parseDate('Sept. 3rd 2022', today), '2022-09-03');
  assert.equal(OHE.parseDate('5 Mar 2021', today), '2021-03-05');
  assert.equal(OHE.parseDate('3/9/2020', today), '2020-03-09');
  assert.equal(OHE.parseDate('2019-12-31T10:00:00Z', today), '2019-12-31');
});

test('parseDate infers missing years and rejects bad input', () => {
  const today = '2024-06-15';
  assert.equal(OHE.parseDate('Delivered on Feb 10', today), '2024-02-10');
  assert.equal(OHE.parseDate('Dec 25', today), '2023-12-25');
  assert.equal(OHE.parseDate('February 31, 2024', today), null);
  assert.equal(OHE.parseDate('Market 12 is open', today), null);
  assert.equal(OHE.parseDate('', today), null);
});

test('parseMoney reads amounts and currencies', () => {
  assert.equal(OHE.parseMoney('$1,234.56').amount, 1234.56);
  assert.equal(OHE.parseMoney('US $45.10').amount, 45.1);
  assert.equal(OHE.parseMoney('-$5.00').amount, -5);
  assert.equal(OHE.parseMoney('$ 12 . 34').amount, 12.34);
  assert.equal(OHE.parseMoney('€9').currency, 'EUR');
  assert.equal(OHE.parseMoney('Free'), null);
  assert.equal(OHE.parseMoney('Qty 2'), null);
});

test('rangeFor covers each preset', () => {
  const today = '2024-03-15';
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'this-year' }, today)), { from: '2024-01-01', to: today });
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'last-year' }, today)), { from: '2023-01-01', to: '2023-12-31' });
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'year', year: '2019' }, today)), { from: '2019-01-01', to: '2019-12-31' });
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'last-30' }, today)), { from: '2024-02-14', to: today });
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'custom', from: '2020-05-01', to: '' }, today)), { from: '2020-05-01', to: null });
  assert.deepEqual(plain(OHE.rangeFor({ preset: 'all' }, today)), { from: null, to: null });
});

test('inRange includes both ends and excludes undated orders from a bounded range', () => {
  const range = { from: '2024-01-01', to: '2024-12-31' };
  assert.equal(OHE.inRange('2024-01-01', range), true);
  assert.equal(OHE.inRange('2024-12-31', range), true);
  assert.equal(OHE.inRange('2023-12-31', range), false);
  assert.equal(OHE.inRange('2025-01-01', range), false);
  assert.equal(OHE.inRange(null, range), false);
  assert.equal(OHE.inRange(null, { from: null, to: null }), true);
});

test('yearsIn lists years newest first', () => {
  assert.deepEqual(plain(OHE.yearsIn({ from: '2022-06-01', to: '2024-02-01' })), [2024, 2023, 2022]);
  assert.deepEqual(plain(OHE.yearsIn({ from: null, to: null }, '2024-03-01')), [2024]);
});

test('csvCell quotes correctly and neutralises formulas', () => {
  assert.equal(OHE.csvCell('a,b'), '"a,b"');
  assert.equal(OHE.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(OHE.csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(OHE.csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(OHE.csvCell('@cmd'), "'@cmd");
  assert.equal(OHE.csvCell(-5), '-5');
  assert.equal(OHE.csvCell(0), '0');
  assert.equal(OHE.csvCell(null), '');
});

test('toCsv item layout puts order money on the first row only', () => {
  const csv = OHE.toCsv([
    { store: 'a', storeName: 'A', date: '2024-01-01', orderId: '1', total: 30, items: [{ name: 'x', price: 10 }, { name: 'y', price: 20 }] },
    { store: 'a', storeName: 'A', date: '2024-02-01', orderId: '2', total: 5, items: [] },
  ]);
  assert.ok(csv.startsWith('﻿Store,Order Date'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  const totalColumn = lines[0].replace('﻿', '').split(',').indexOf('Order Total');
  assert.equal(lines[1].split(',')[totalColumn], '5'); // newest first; itemless order keeps a row
  assert.equal(lines[2].split(',')[totalColumn], '30');
  assert.equal(lines[3].split(',')[totalColumn], '');
});

test('toCsv order layout gives one row per order', () => {
  const csv = OHE.toCsv([{ store: 'a', date: '2024-01-01', orderId: '1', total: 30, items: [{ name: 'x' }, { name: 'y' }] }], 'orders');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /x; y/);
});

test('mergeOrder fills fields and keeps the fuller item list', () => {
  const base = { orderId: '1', total: 5, items: [{ name: 'a' }, { name: 'b' }] };
  assert.equal(OHE.mergeOrder(base, { items: [{ name: 'a' }] }).items.length, 2);
  const merged = OHE.mergeOrder(base, { tax: 0, status: '', items: [{ name: 'a', price: 1 }, { name: 'b', price: 2 }] });
  assert.equal(merged.tax, 0);
  assert.equal(merged.items[0].price, 1);
  assert.equal(merged.status, undefined);
  assert.equal(merged.orderId, '1');
});

test('amazon list: orders, labels, totals, items, pagination, year discovery', () => {
  const win = load(fixture('amazon-list'), 'https://www.amazon.com/your-orders/orders?timeFilter=year-2024');
  const store = win.OHE.stores.amazon;
  const { orders, enqueue } = plain(store.extractList(win.document, CTX));
  assert.equal(orders.length, 2);
  assert.equal(orders[0].orderId, '111-1111111-1111111');
  assert.equal(orders[0].date, '2024-12-20');
  assert.equal(orders[0].total, 1042.17);
  assert.equal(orders[0].status, 'Delivered December 22');
  assert.deepEqual(orders[0].items.map((i) => i.name), ['Stainless Steel Kettle, 1.7 L', '=Formula Looking Cable']);
  assert.equal(orders[0].items[0].quantity, 2);
  assert.equal(orders[1].date, '2024-03-03');
  assert.deepEqual(enqueue, []); // the range already names its years
  assert.equal(store.extractList(win.document, { today: CTX.today, range: {} }).enqueue.length, 2);
  assert.match(store.nextElement(win.document).getAttribute('href'), /startIndex=10/);
});

test('amazon last page has no next link', () => {
  const win = load(fixture('amazon-list-2'));
  assert.equal(win.OHE.stores.amazon.nextElement(win.document), null);
});

test('amazon detail: summary rows and item prices', () => {
  const win = load(fixture('amazon-detail'));
  const patch = plain(win.OHE.stores.amazon.extractDetail(win.document));
  assert.equal(patch.total, 1042.17);
  assert.equal(patch.subtotal, 1012);
  assert.equal(patch.tax, 30.17);
  assert.equal(patch.shipping, 0);
  assert.equal(patch.items.length, 2);
  assert.equal(patch.items[0].price, 500);
  assert.equal(patch.items[0].seller, 'Kettle Co');
});

test('amazon detects sign-in and captcha', () => {
  const win = load();
  const store = win.OHE.stores.amazon;
  assert.equal(store.detect(win.document, { pathname: '/ap/signin' }), 'login');
  assert.equal(store.detect(win.document, { pathname: '/errors/validateCaptcha' }), 'challenge');
  assert.equal(store.detect(win.document, { pathname: '/your-orders/orders' }), null);
});

test('ebay ignores captcha elements on a normal page, but not a captcha URL', () => {
  const win = load('<!doctype html><body><div id="captcha_loading" hidden></div><iframe src="/captcha/x"></iframe></body>', 'https://www.ebay.com/mye/myebay/purchase');
  const store = win.OHE.stores.ebay;
  assert.equal(store.detect(win.document, { hostname: 'www.ebay.com', pathname: '/mye/myebay/purchase' }), null);
  assert.equal(store.detect(win.document, { hostname: 'www.ebay.com', pathname: '/splashui/captcha' }), 'challenge');
});

test('run accepts the user overriding a mistaken security check, but not a sign-in', async () => {
  const win = load(fixture('amazon-list-2'));
  const store = win.OHE.stores.amazon;
  const realDetect = store.detect;
  store.detect = () => 'challenge';
  assert.equal((await win.OHE.run({ storeId: 'amazon', today: CTX.today })).status, 'challenge');
  assert.equal((await win.OHE.run({ storeId: 'amazon', today: CTX.today, ignoreChallenge: true })).status, 'ok');
  store.detect = () => 'login';
  assert.equal((await win.OHE.run({ storeId: 'amazon', today: CTX.today, ignoreChallenge: true })).status, 'login');
  store.detect = realDetect;
});

test('payment reads each format and combines split payments', () => {
  const pay = (body) => {
    const win = load(`<!doctype html><body>${body}</body>`);
    return win.OHE.dom.payment(win.document.body);
  };
  assert.equal(pay('<p>American Express ending in 1234</p>'), 'American Express ending 1234');
  assert.equal(pay('<p>Payment Method: Visa | Last digits: 5678</p>'), 'Visa ending 5678');
  assert.equal(pay('<p>Visa x-4321</p>'), 'Visa ending 4321');
  assert.equal(pay('<p>Mastercard ****9999</p>'), 'Mastercard ending 9999');
  assert.equal(pay('<div><h3>Payment method</h3><p>Ending in 1111</p></div>'), 'Card ending 1111');
  assert.equal(pay('<div><h3>Payment method</h3><p>Cash</p></div>'), 'Cash');
  assert.equal(pay('<div><h3>Payment</h3><p>PayPal</p></div>'), 'PayPal');
  assert.equal(
    pay('<div><h3>Payment methods</h3><ul><li>Visa ending in 1234 $5.00</li><li>Gift card $2.00</li></ul></div>'),
    'Visa ending 1234; Gift card'
  );
});

test('payment never exposes full numbers or addresses, and ignores look-alikes', () => {
  const pay = (body) => {
    const win = load(`<!doctype html><body>${body}</body>`);
    return win.OHE.dom.payment(win.document.body);
  };
  assert.equal(pay('<div><h3>Payment method</h3><p>Visa 4111 1111 1111 1111</p></div>'), undefined);
  assert.equal(pay('<div><h3>Payment method</h3><p>Visa ending 4111 1111 1111 1111</p></div>'), undefined);
  assert.equal(pay('<div><h3>Payment method</h3><p>Billing address: 12 Oak Road</p></div>'), undefined);
  assert.equal(pay('<p>Phone ending in 5555</p>'), undefined);
  assert.equal(pay('<p>Pay with cash at the store. Earn cash back.</p>'), undefined);
  assert.equal(pay('<div><h3>Payment method</h3><p>Earn cash back</p></div>'), undefined);
});

test('walmart recognises a text or email code page, but not on a page with orders', () => {
  const store = (win) => win.OHE.stores.walmart;
  const orders = { pathname: '/orders' };
  const codePage = load('<!doctype html><body><h1>Verify it\'s you</h1><p>We\'ll send a code to your phone or email.</p></body>');
  assert.equal(store(codePage).detect(codePage.document, orders), 'verify');
  const byPath = load();
  assert.equal(store(byPath).detect(byPath.document, { pathname: '/account/verify' }), 'verify');
  const list = load(fixture('walmart-list').replace('</main>', '<p>Never share your verification code.</p></main>'));
  assert.equal(store(list).detect(list.document, orders), null);
});

test('parseAddress separates street and ZIP and leaves out the name', () => {
  const { parseAddress } = OHE.dom;
  assert.deepEqual(plain(parseAddress('Jo Smith 12 Oak Road Apt 4 Bentonville, AR 72712 United States')), {
    deliveryAddress: '12 Oak Road Apt 4 Bentonville, AR 72712',
    deliveryZip: '72712',
  });
  assert.equal(parseAddress('Jo Smith 12 Oak Road Boston, MA 02134-1234').deliveryZip, '02134-1234');
  assert.equal(parseAddress('Jo Smith PO Box 9 Boston, MA 02134').deliveryAddress, 'PO Box 9 Boston, MA 02134');
  assert.equal(parseAddress('Jo Smith Bentonville, AR 72712').deliveryAddress, undefined);
  assert.equal(parseAddress('Jo Smith Bentonville, AR 72712').deliveryZip, '72712');
  assert.equal(parseAddress('Jo Smith, no address here'), null);
});

test('deliveryAddress reads delivery labels only, not billing or pickup addresses', () => {
  const read = (body) => {
    const win = load(`<!doctype html><body>${body}</body>`);
    return plain(win.OHE.dom.deliveryAddress(win.document.body));
  };
  const home = '<p>Jo Smith 12 Oak Road Bentonville, AR 72712</p>';
  for (const label of ['Shipping address', 'Delivery address', 'Ship to', 'Delivers to']) {
    assert.equal(read(`<div><h3>${label}</h3>${home}</div>`).deliveryZip, '72712', label);
  }
  assert.deepEqual(read(`<div><h3>Billing address</h3>${home}</div>`), {});
  assert.deepEqual(read(`<div><h3>Pickup location</h3>${home}</div>`), {});
  assert.deepEqual(read('<div><h3>Delivery</h3><p>$5.00</p></div>'), {});
});

test('store detail pages add the delivery address', () => {
  const amazon = load('<!doctype html><body><div id="orderDetails"></div><div data-component="shippingAddress"><ul><li>Jo Smith</li><li>12 Oak Road</li><li>Boston, MA 02134</li></ul></div></body>');
  const fromAmazon = plain(amazon.OHE.stores.amazon.extractDetail(amazon.document));
  assert.equal(fromAmazon.deliveryAddress, '12 Oak Road Boston, MA 02134');
  assert.equal(fromAmazon.deliveryZip, '02134');

  const page = '<!doctype html><body><main><h3>Shipping address</h3><p>Jo Smith 12 Oak Road Boston, MA 02134</p></main></body>';
  for (const id of ['walmart', 'samsclub', 'ebay']) {
    const win = load(page);
    assert.equal(win.OHE.stores[id].extractDetail(win.document).deliveryZip, '02134', id);
  }
});

test('CSV keeps ZIP leading zeros and both address columns', () => {
  const order = { store: 'a', date: '2024-01-01', orderId: '1', deliveryAddress: '12 Oak Road Boston, MA 02134', deliveryZip: '02134', items: [{ name: 'x' }] };
  for (const layout of ['items', 'orders']) {
    const csv = OHE.toCsv([order], layout);
    assert.ok(csv.includes('Delivery Address,Delivery ZIP'), layout);
    assert.ok(csv.includes('"12 Oak Road Boston, MA 02134",02134'), layout);
  }
});

test('parseDate reads two-digit years', () => {
  assert.equal(OHE.parseDate('10/07/26', '2026-11-05'), '2026-10-07');
  assert.equal(OHE.parseDate('10/07/2026 at 10:00am', '2026-11-05'), '2026-10-07');
});

test('summary does not mistake Total Tax or Total Shipping for the order total', () => {
  const win = load(fixture('newegg-detail'));
  const totals = plain(win.OHE.dom.summary(win.document.body));
  assert.deepEqual(totals, { total: 1234.5, subtotal: 1200, tax: 34.5, shipping: 0, currency: 'USD' });
});

test('newegg list: order, seller, quantity, split price', () => {
  const win = load(fixture('newegg-list'), 'https://secure.newegg.com/orders/list');
  const { orders } = plain(win.OHE.stores.newegg.extractList(win.document, CTX));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '111222333');
  assert.equal(orders[0].date, '2024-03-15');
  assert.equal(orders[0].total, 1234.5);
  assert.equal(orders[0].status, 'Delivered');
  assert.match(orders[0].detailUrl, /orders\/cart\?CartID=AAA$/);
  assert.deepEqual(orders[0].items[0], {
    name: 'Test Graphics Card 16GB',
    url: 'https://www.newegg.com/widget/p/N1',
    quantity: 2,
    seller: 'Example Seller',
  });
});

test('newegg views: recent, plus only the years in range', () => {
  const win = load(fixture('newegg-list'), 'https://secure.newegg.com/orders/list');
  const views = (range) => plain(win.OHE.stores.newegg.views.list(win.document, { today: '2026-11-05', range }));
  assert.deepEqual(views({ from: '2024-01-01', to: '2024-12-31' }), [null, '2024']);
  assert.deepEqual(views({ from: null, to: null }), [null, '120', '2024', '2018']);
  assert.deepEqual(views({ from: '2026-10-01', to: '2026-11-05' }), [null, '120']);
});

test('newegg detail: address, receipt payment, totals, and multi-order checkouts', () => {
  const win = load(fixture('newegg-detail'));
  const store = win.OHE.stores.newegg;
  const patch = plain(store.extractDetail(win.document));
  assert.equal(patch.deliveryAddress, '12 Oak Road Apt 4 Boston,MA 02134-1234');
  assert.equal(patch.deliveryZip, '02134-1234');
  assert.equal(patch.payment, 'BitPay');
  assert.equal(patch.tax, 34.5);
  assert.equal(patch.items[0].price, 600);
  assert.equal(patch.items.length, 1);

  const multi = load(fixture('newegg-detail').replace('<span class="order-item-tag">Order 1</span>', '<span class="order-item-tag">Order 1</span><span class="order-item-tag">Order 2</span>'));
  const shared = plain(multi.OHE.stores.newegg.extractDetail(multi.document));
  assert.equal(shared.total, undefined, 'a checkout total must not overwrite one order total');
  assert.equal(shared.items, undefined);
  assert.equal(shared.deliveryZip, '02134-1234');
});

test('newegg detail reads a card brand from its icon, and PayPal from text', () => {
  const page = (body) =>
    fixture('newegg-detail').replace(
      '<div class="fieldset"><div class="fieldset-legend">BitPay Receipt</div><div class="fieldset-body"><p>To view your BitPay payment receipt, please use this link.</p></div></div>',
      `<div class="fieldset"><div class="fieldset-legend">Payment Method</div><div class="fieldset-body">${body}</div></div>`
    );
  const payment = (body) => {
    const win = load(page(body));
    return win.OHE.stores.newegg.extractDetail(win.document).payment;
  };
  const billing = '<div>Jo Smith</div><div>12 Oak Road Boston,MA 02134</div>';
  assert.equal(payment(`${billing}<div class="card-msg"><i class="card-icon type-discover"></i><span>ending in 1234</span></div>`), 'Discover ending 1234');
  assert.equal(payment(`${billing}<div class="card-msg"><span>PayPal</span></div>`), 'PayPal');
});

test('home depot reads payment from the details page, and cleans logo text', () => {
  const win = load(fixture('homedepot-detail'), 'https://www.homedepot.com/myaccount/order-details');
  const store = win.OHE.stores.homedepot;
  assert.equal(store.extractDetail(win.document).payment, 'Visa ending 0027');

  const list = load(fixture('homedepot-list').replace('alt="visa"', 'alt="visa-card"'), 'https://www.homedepot.com/myaccount/purchase-history');
  const { orders } = plain(list.OHE.stores.homedepot.extractList(list.document, { today: '2026-11-05', range: {} }));
  assert.equal(orders[1].payment, 'Visa ending 8279');
});

test('home depot list: table columns, returns, payment logo', () => {
  const win = load(fixture('homedepot-list'), 'https://www.homedepot.com/myaccount/purchase-history');
  const { orders } = plain(win.OHE.stores.homedepot.extractList(win.document, { today: '2026-11-05', range: {} }));
  assert.equal(orders.length, 3);
  assert.equal(orders[0].orderId, '00001-11111');
  assert.equal(orders[0].date, '2026-10-07');
  assert.equal(orders[0].total, 97.43);
  assert.equal(orders[0].payment, 'Mastercard ending 0027');
  assert.deepEqual(orders[0].items.map((i) => i.name), ['1 in. Test Conduit', 'Test Junction Box']);
  assert.match(orders[0].detailUrl, /^https:\/\/www\.homedepot\.com\/myaccount\/order-details/);
  assert.equal(orders[1].total, -50.81);
  assert.equal(orders[1].payment, 'Visa ending 8279');
  assert.equal(orders[2].payment, undefined);
  assert.equal(win.OHE.stores.homedepot.nextElement(win.document).getAttribute('aria-label'), 'Skip to Next Page');
});

test('home depot uses the wider date filter only when the range needs it', () => {
  const win = load(fixture('homedepot-list'), 'https://www.homedepot.com/myaccount/purchase-history');
  const views = (range) => plain(win.OHE.stores.homedepot.views.list(win.document, { today: '2026-11-05', range }));
  assert.deepEqual(views({ from: '2026-01-01', to: '2026-11-05' }), [null]);
  assert.deepEqual(views({ from: '2020-01-01', to: '2020-12-31' }), ['Last 7 Years']);
  assert.deepEqual(views({ from: null, to: null }), ['Last 7 Years']);
});

test('home depot detail: items, unit price, money rows, no fake delivery address', () => {
  const win = load(fixture('homedepot-detail'), 'https://www.homedepot.com/myaccount/order-details');
  const patch = plain(win.OHE.stores.homedepot.extractDetail(win.document));
  assert.equal(patch.total, 97.43);
  assert.equal(patch.subtotal, 90);
  assert.equal(patch.tax, 7.43);
  assert.deepEqual(patch.items, [
    { name: '1 in. Test Conduit With A Long Name', quantity: 1, price: 7.5 },
    { name: 'Test Junction Box 4 in. Deep', quantity: 3, price: 10 },
  ]);
  assert.equal(patch.deliveryZip, undefined);
});

test('CSV has a payment column in both layouts', () => {
  const order = { store: 'a', date: '2024-01-01', orderId: '1', payment: 'Visa ending 1234', items: [{ name: 'x' }, { name: 'y' }] };
  const items = OHE.toCsv([order]).trim().split('\r\n');
  assert.ok(items[0].includes('Payment Method'));
  assert.ok(items[1].includes('Visa ending 1234'));
  assert.ok(items[2].includes('Visa ending 1234'));
  assert.ok(OHE.toCsv([order], 'orders').includes('Visa ending 1234'));
});

test('walmart list: groups by order id without relying on class names', () => {
  const win = load(fixture('walmart-list'), 'https://www.walmart.com/orders');
  const store = win.OHE.stores.walmart;
  const { orders } = plain(store.extractList(win.document, CTX));
  assert.equal(orders.length, 2);
  assert.equal(orders[0].orderId, '2000123456789');
  assert.equal(orders[0].date, '2024-10-03');
  assert.match(orders[0].status, /^Delivered/);
  assert.deepEqual(orders[0].items.map((i) => i.name), ['Great Value Whole Milk, 1 Gallon', 'Bananas, Each']);
  assert.equal(orders[0].detailUrl, 'https://www.walmart.com/orders/2000123456789');
  assert.equal(orders[1].orderId, '20001122334455667788');
  assert.equal(orders[1].date, '2024-08-11');
  assert.match(orders[1].detailUrl, /storePurchase=true$/);
});

test('walmart detail: item price, quantity, free delivery', () => {
  const win = load(fixture('walmart-detail'), 'https://www.walmart.com/orders/1');
  const patch = plain(win.OHE.stores.walmart.extractDetail(win.document));
  assert.equal(patch.total, 9.45);
  assert.equal(patch.subtotal, 8.75);
  assert.equal(patch.shipping, 0);
  assert.equal(patch.tax, 0.7);
  assert.deepEqual(patch.items.map((i) => [i.name, i.quantity, i.price]), [
    ['Great Value Whole Milk, 1 Gallon', 2, 7.5],
    ['Bananas, Each', 1, 1.25],
  ]);
});

test("sam's club shares the walmart parser with its own origin", () => {
  const win = load(fixture('walmart-list'), 'https://www.samsclub.com/orders');
  const store = win.OHE.stores.samsclub;
  const { orders } = plain(store.extractList(win.document, CTX));
  assert.equal(orders[0].detailUrl, 'https://www.samsclub.com/orders/2000123456789');
  assert.deepEqual(plain(store.startUrls()), ['https://www.samsclub.com/orders']);
});

test('ebay JSON: groups cards into orders and reads every field', () => {
  const store = load().OHE.stores.ebay;
  const json = JSON.parse(read('tests/fixtures/ebay-api.json'));
  const { orders, more } = plain(store.listApi.parse(json, CTX));
  assert.equal(more, true);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '12-34567-89012');
  assert.equal(orders[0].date, '2024-09-09');
  assert.equal(orders[0].total, 45.1);
  assert.equal(orders[0].currency, 'USD');
  assert.match(orders[0].detailUrl, /^https:\/\/order\.ebay\.com\//);
  assert.deepEqual(orders[0].items[0], {
    name: 'Vintage Film Camera',
    price: 30.1,
    quantity: 2,
    seller: 'camera_seller',
    url: 'https://www.ebay.com/itm/123456789012',
  });
  assert.equal(orders[0].items[1].quantity, 1);
  assert.equal(store.listApi.parse({ modules: { RIVER: [{ data: {} }] } }, CTX).more, false);
});

test('ebay year terms follow the range', () => {
  const store = load().OHE.stores.ebay;
  const terms = (range) => plain(store.listApi.terms(range, '2026-11-05'));
  assert.deepEqual(terms({ from: '2024-02-01', to: '2025-03-01' }), ['LAST_YEAR', 'TWO_YEARS_AGO']);
  assert.deepEqual(terms({ from: '2026-01-01', to: '2026-11-05' }), ['CURRENT_YEAR']);
  assert.equal(terms({ from: null, to: null }).length, 23);
  assert.deepEqual(terms({ from: '1990-01-01', to: '1990-12-31' }), []);
});

test('ebay page fallback: labels, items, seller', () => {
  const win = load(fixture('ebay-list'), 'https://www.ebay.com/mye/myebay/purchase');
  const store = win.OHE.stores.ebay;
  const { orders } = plain(store.extractList(win.document, CTX));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '12-34567-89012');
  assert.equal(orders[0].date, '2024-09-09');
  assert.equal(orders[0].total, 45.1);
  assert.equal(orders[0].items.length, 2);
  assert.equal(orders[0].items[0].price, 30.1);
  assert.equal(orders[0].items[0].seller, 'camera_seller');
  assert.match(orders[0].detailUrl, /^https:\/\/order\.ebay\.com\//);
});

test('run reports a page it cannot parse, and an empty one as empty', async () => {
  const unknown = load('<!doctype html><body><p>Something new</p></body>');
  const result = await unknown.OHE.run({ storeId: 'amazon', today: CTX.today, timeoutMs: 50 });
  assert.equal(result.status, 'unparsed');

  const empty = load('<!doctype html><body><p>You have not placed any orders in 2019.</p></body>');
  const emptyResult = await empty.OHE.run({ storeId: 'amazon', today: CTX.today, timeoutMs: 4000 });
  assert.equal(emptyResult.status, 'ok');
  assert.equal(emptyResult.empty, true);
});

test('run returns stale when the next button did not change the list', async () => {
  const win = load(fixture('amazon-list-2'));
  const first = await win.OHE.run({ storeId: 'amazon', today: CTX.today });
  assert.equal(first.status, 'ok');
  const second = await win.OHE.run({ storeId: 'amazon', today: CTX.today, notFingerprint: first.fingerprint, timeoutMs: 50 });
  assert.equal(second.status, 'stale');
});

test('snapshot removes personal details but keeps structure', () => {
  const win = load(
    `<!doctype html><body><div class="order-card" data-testid="order-1234567" title="Jo Smith">
      <span>Order placed</span><span>Jo Smith, 12 Oak Road</span><span>$99.10</span>
      <h3>Shipping address</h3><p>Jo Smith 12 Oak Road Boston, MA 02134</p>
      <a href="https://www.walmart.com/orders/2000123456789?token=secret&name=jo">View details</a>
      <input value="jo@example.com"><img alt="Private Medicine" src="x.jpg">
    </div></body>`
  );
  const html = win.OHE.snapshot();
  for (const secret of ['Jo', 'Smith', 'Oak', 'Boston', '02134', '99.10', '2000123456789', 'secret', 'jo@example.com', 'Medicine', '1234567']) {
    assert.ok(!html.includes(secret), `snapshot leaked "${secret}"`);
  }
  assert.ok(html.includes('order-card'));
  assert.ok(html.includes('Order placed'));
});

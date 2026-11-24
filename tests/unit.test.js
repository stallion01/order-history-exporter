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
  'src/stores/target.js',
  'src/stores/costco.js',
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
  assert.equal(patch.items.length, 2, 'recommendations on the page are not items');
  assert.ok(!patch.items.some((item) => /Suggested/.test(item.name)));
  assert.equal(patch.items[0].price, 500);
  assert.equal(patch.items[0].seller, 'Kettle Co');
});

// Before the order is drawn, an Amazon details page holds only the top bar, the side
// cart and the footer, whose links (Amazon's own card ads among them) are not items bought.
const AMAZON_CHROME = `<header id="navbar"><a href="/gp/product/B000000009/ref=nav_x">Today's Deals</a></header>
  <div id="nav-flyout-ewc"><div id="ewc-content"><a href="/gp/product/B000000002/ref=ewc_title_delete1?psc=1">Example Crew Socks (6 Pairs)</a>
    <span class="a-price"><span class="a-offscreen">$30.00</span></span><div>Subtotal $30.00</div></div></div>
  <div id="navFooter"><a href="/dp/product/B000000003?plattr=SCFOOT&amp;ref_=footer_ACB">Amazon Secured Card</a>
    <a href="/dp/B000000004?plattr=ACOMFO&amp;ref_=footer_pay_sbcc">Amazon Business Card</a></div>`;

test('amazon detail: the top bar, side cart and footer are not the order', async () => {
  const early = load(`<!doctype html><body>${AMAZON_CHROME}</body>`, 'https://www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001');
  const patch = plain(early.OHE.stores.amazon.extractDetail(early.document));
  assert.deepEqual(patch.items, []);
  assert.equal(patch.subtotal, undefined, "the side cart's subtotal is not the order's");
  // So the page isn't taken as read yet; given time and nothing more, it's reported unread.
  assert.equal((await early.OHE.run({ storeId: 'amazon', mode: 'detail', order: {}, today: CTX.today, timeoutMs: 50 })).status, 'unparsed');

  // Once the order is drawn, only its items are read.
  const drawn = load(fixture('amazon-detail').replace('<body>', `<body>${AMAZON_CHROME}`));
  const read = plain(drawn.OHE.stores.amazon.extractDetail(drawn.document));
  assert.equal(read.items.length, 2);
  assert.ok(!read.items.some((item) => /Card|Socks/.test(item.name)));
  assert.equal(read.subtotal, 1012);
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

test("sam's club order page: split prices, fractional quantity, logo payment, no store address as delivery", () => {
  const win = load(fixture('samsclub-detail'), 'https://www.samsclub.com/en/orders/1');
  const patch = plain(win.OHE.stores.samsclub.extractDetail(win.document));
  assert.deepEqual(patch.items, [
    { name: 'Test Paper Towels 12 Rolls', quantity: 2, price: 10.5, lineTotal: 21 },
    { name: 'Unleaded Fuel', quantity: 10.5, price: 3.12, lineTotal: 32.85 },
  ]);
  assert.equal(patch.payment, 'Discover ending 1234', 'a repeated section is not counted twice');
  assert.equal(patch.date, '2025-10-12', 'the full date comes from the heading, not the greeting');
  assert.equal(patch.total, 58.6);
  assert.equal(patch.subtotal, 53.85);
  assert.equal(patch.tax, 4.75);
  assert.equal(patch.deliveryZip, undefined, 'a club address is not a delivery address');
});

test('thumbnail fallback leaves out barcodes and payment logos', () => {
  const win = load(
    `<!doctype html><body><main>
      <img alt="barcode"><img alt="Mastercard"><img alt="Discover"><img alt="Cash"><img alt="Great Value Milk">
      <div><h3>Order total</h3><p>$5.00</p></div></main></body>`,
    'https://www.samsclub.com/orders/1'
  );
  const { items } = plain(win.OHE.stores.samsclub.extractDetail(win.document));
  assert.deepEqual(items.map((i) => i.name), ['Great Value Milk']);
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

/* ---------- Target ---------- */

const TARGET_URL = 'https://www.target.com/orders';

test('target online list: orders by link, packages, picture names, no buy-again or receipt links', () => {
  const win = load(fixture('target-list'), TARGET_URL);
  const store = win.OHE.stores.target;
  const { orders } = plain(store.extractList(win.document, { today: '2026-11-24', range: {} }));
  assert.deepEqual(orders.map((o) => o.orderId), ['912000000000001', '912000000000002', '912000000000003']);
  assert.equal(orders[0].date, '2026-11-20');
  assert.equal(orders[0].total, 60.41);
  assert.equal(orders[0].status, 'Picked up, Drive Up at Anytown East');
  assert.deepEqual(orders[0].items, [{ name: '17" Test Rope Bin Gray - Testroom™', quantity: 2 }, { name: 'Test Thank You Notes 24ct - up&up™' }]);
  assert.equal(orders[1].detailUrl, 'https://www.target.com/orders/912000000000002');
  assert.equal(orders[1].status, 'Picked up, Drive Up at Anytown South; Delivered Thu, Aug 27; Canceled, Wed, Aug 26');
  // A cancelled package's items aren't listed, here or on the order's page.
  assert.deepEqual(orders[1].items.map((i) => i.name), ['Test Step Trash Can 46L', 'Test Freezer Bags 30ct']);
  assert.deepEqual(orders[2].items, []);
  assert.equal(orders[2].total, 0);
  assert.equal(orders[2].status, 'Canceled on Wed, May 6');
});

test('target in-store list: store purchases keep their own ids and pages', () => {
  const win = load(fixture('target-list-instore'), TARGET_URL);
  const { orders } = plain(win.OHE.stores.target.extractList(win.document, { today: '2026-11-24', range: {} }));
  assert.deepEqual(orders.map((o) => o.orderId), ['1111-2222-3333-4444', '1111-2222-3333-5555']);
  assert.equal(orders[0].date, '2026-11-20');
  assert.equal(orders[0].total, 67.46);
  assert.equal(orders[0].status, 'Purchased, Store trip at Anytown South');
  assert.equal(orders[0].detailUrl, 'https://www.target.com/orders/stores/1111-2222-3333-4444');
  assert.deepEqual(orders[0].items.map((i) => i.name), ['96"x30" Test Wrapping Paper - Testz™', 'Test Correction Fluid 0.3 fl oz']);
});

test('target loads more purchases only until the list reaches the start date', () => {
  const win = load(fixture('target-list'), TARGET_URL);
  const store = win.OHE.stores.target;
  store.extractList(win.document, { today: '2026-11-24', range: { from: '2026-01-01', to: '2026-11-24' } });
  assert.match(store.nextElement(win.document).textContent, /Load more purchases/);
  store.extractList(win.document, { today: '2026-11-24', range: { from: '2026-06-01', to: '2026-11-24' } });
  assert.equal(store.nextElement(win.document), null);
  store.extractList(win.document, { today: '2026-11-24', range: {} });
  assert.ok(store.nextElement(win.document));
});

test('target views: both tabs, and switching waits for the other tab to be chosen', async () => {
  const win = load(fixture('target-list'), TARGET_URL);
  const store = win.OHE.stores.target;
  assert.deepEqual(plain(store.views.list(win.document, {})), ['online', 'instore']);
  assert.equal(await store.views.apply(win.document, 'online'), true);
  const instore = win.document.querySelector('[data-test="tabInstore"]');
  instore.addEventListener('click', () => {
    instore.setAttribute('aria-selected', 'true');
    win.document.querySelector('[data-test="tab-tabContent-tab-Online"]').innerHTML = '<a href="/orders/stores/1111-2222-3333-4444">View purchase</a>';
  });
  assert.equal(await store.views.apply(win.document, 'instore'), true);
  assert.equal(load().OHE.stores.target.views.list(load().document, {}), null);
});

test('target detail: unit prices in each wording, no cancelled items, money rows, free fulfillment, card, address', () => {
  const win = load(fixture('target-detail'), 'https://www.target.com/orders/912000000000002');
  const patch = plain(win.OHE.stores.target.extractDetail(win.document));
  assert.deepEqual(patch.items, [
    { name: '15pc Test Drawing Set - Testco™', quantity: 1, price: 10 },
    { name: 'Test Gummy Candy', quantity: 2, price: 2.99 },
    { name: '46L Test Step Trash Can', quantity: 1, price: 35 },
  ]);
  // The cancelled clipper isn't among them, so the items add up to the subtotal.
  assert.equal(Math.round(patch.items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100, 50.98);
  assert.equal(patch.total, 50.69);
  assert.equal(patch.subtotal, 50.98);
  assert.equal(patch.tax, 2.26);
  assert.equal(patch.shipping, 0);
  assert.equal(patch.currency, 'USD');
  assert.equal(patch.payment, 'Target Circle Debit Card ending 1234');
  assert.equal(patch.deliveryAddress, '12 Test Orchard Dr SE Anytown, MI 49000');
  assert.equal(patch.deliveryZip, '49000');
});

test('target detects sign-in, and a payment name that is not a plain card name is not copied', () => {
  const win = load(
    '<!doctype html><body><span><span data-test="breakdown-payment_sub_type_value">Pat Example 12 Oak Road</span><span>* 4321</span></span></body>',
    'https://www.target.com/orders/1'
  );
  const store = win.OHE.stores.target;
  assert.equal(store.extractDetail(win.document).payment, 'Card ending 4321');
  assert.equal(store.detect(win.document, { hostname: 'www.target.com', pathname: '/login' }), 'login');
  assert.equal(store.detect(win.document, { hostname: 'www.target.com', pathname: '/orders' }), null);
});

/* ---------- Costco ---------- */

const COSTCO_URL = 'https://www.costco.com/myaccount/';
const RECEIPT = '21099900100112611201230';

test('costco warehouse list: receipts, warehouse, refund, next page', () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const store = win.OHE.stores.costco;
  const { orders } = plain(store.extractList(win.document, { today: '2026-11-24', range: {} }));
  assert.deepEqual(orders.map((o) => o.orderId), [RECEIPT, '21099900200222611051815', '21099900100332610021105']);
  assert.equal(orders[0].date, '2026-11-20');
  assert.equal(orders[0].total, 379.61);
  assert.equal(orders[0].status, 'In-Warehouse, ANYTOWN');
  assert.equal(orders[0].detailUrl, 'https://www.costco.com/OrderStatusCmd');
  assert.equal(orders[2].total, -402.79);
  assert.equal(orders[2].status, 'In-Warehouse refund, ANYTOWN');
  assert.equal(store.nextElement(win.document).getAttribute('aria-label'), 'Go to next page');
});

test('costco receipt: quantities, money off taken out of its item, deposits, tax and card', () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const patch = plain(win.OHE.stores.costco.extractDetail(win.document, { orderId: RECEIPT }));
  assert.deepEqual(patch.items, [
    { name: 'KS TEST BACON', quantity: 1, price: 12.99, lineTotal: 12.99 },
    { name: 'TEST WATCH 44MM', quantity: 1, price: 309.99, lineTotal: 309.99 },
    { name: 'TEST TOTE 2PK', quantity: 2, price: 9.99, lineTotal: 19.98 },
    { name: 'TEST ALLERGY 365', quantity: 1, price: 13.49, lineTotal: 13.49 },
    { name: 'ST BOTTLE DEPST EE/80008', quantity: 1, price: 3, lineTotal: 3 },
  ]);
  const itemsTotal = patch.items.reduce((sum, item) => sum + item.lineTotal, 0);
  assert.equal(Math.round(itemsTotal * 100) / 100, patch.subtotal);
  assert.equal(patch.subtotal, 359.45);
  assert.equal(patch.tax, 20.16);
  assert.equal(patch.total, 379.61);
  assert.equal(patch.payment, 'Visa ending 1234');
  // Another receipt's popup is not this order's details.
  assert.equal(win.OHE.stores.costco.extractDetail(win.document, { orderId: '21099900200222611051815' }), null);
});

test('costco refund receipt: negative amounts, and the card by its last digits only', () => {
  const id = '21099900100332610021105';
  const win = load(
    `<!doctype html><body><div id="dataToPrint"><div>${id}</div><table><tbody>
      <tr><td></td><td>90009</td><td>TEST PRINTER</td><td>379.99- Y</td></tr>
      <tr><td colspan="2"></td><td>SUBTOTAL</td><td>379.99-</td></tr>
      <tr><td colspan="2"></td><td>TAX</td><td>22.80-</td></tr>
      <tr><td></td><td>****</td><td>Total</td><td>402.79-</td></tr>
      <tr><td colspan="3">XXXXXXXXXXXXX1234</td><td>CHIP read</td></tr>
      <tr><td colspan="3">APPROVED - REFUND</td><td></td></tr>
      <tr><td></td><td colspan="2">RTC Whse Purchase</td><td>402.79-</td></tr>
    </tbody></table></div></body>`,
    COSTCO_URL
  );
  const patch = plain(win.OHE.stores.costco.extractDetail(win.document, { orderId: id }));
  assert.deepEqual(patch.items, [{ name: 'TEST PRINTER', quantity: 1, price: -379.99, lineTotal: -379.99 }]);
  assert.equal(patch.total, -402.79);
  assert.equal(patch.tax, -22.8);
  assert.equal(patch.payment, 'Card ending 1234');
});

test('costco fuel receipt: gallons, price a gallon and the card, though it shows no receipt number', async () => {
  const id = '21099908100012607151826';
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const doc = win.document;
  doc.getElementById('receipt-popup').remove();
  const card = doc.querySelector('[id^="viewRecieptBtn_"]');
  card.id = `viewRecieptBtn_${id}`;
  card.querySelector('[automation-id="In-Warehouse"] div').firstChild.nodeValue = 'Gas Station';
  const { orders } = plain(win.OHE.stores.costco.extractList(doc, { today: '2026-11-24', range: {} }));
  assert.equal(orders[0].status, 'Gas Station, ANYTOWN');
  card.querySelector('button').addEventListener('click', () => {
    doc.body.insertAdjacentHTML(
      'beforeend',
      `<div role="dialog"><h2 id="alert-dialog-title">Gas Station Receipt</h2><div id="dataToPrint"><div>
        <div><img alt="Costco Wholesale"><div>Anytown # 999</div><div>100 TEST ST SE</div><div>ANYTOWN , MI 49000</div></div>
        <div><div>Member</div><div>111000000000</div><div>Invoice #</div><div>10001</div><div>Date :</div><div>07/15/26</div><div>Time :</div><div>18:26</div><div>Auth #</div><div>00000A</div></div>
        <div><div>VI Acct #</div><div>************ 1234</div></div>
        <div><div>Pump</div><div>Gallons</div><div>Price</div><div>8</div><div>23.120</div><div>$3.829</div></div>
        <div><div>Product</div><div>Amount</div><div>Regular</div><div>$88.53</div><div>Total Sale</div><div>$88.53</div></div>
        <div><div>Sale - Contactless</div><div>Approved</div><div>TranID # 000000000001</div></div>
      </div></div><button automation-id="closePopup" type="button">Close</button></div>`
    );
  });
  const result = await win.OHE.run({ storeId: 'costco', mode: 'detail', order: { orderId: id, date: '2026-11-20' }, today: '2026-11-24' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(plain(result.patch), {
    items: [{ name: 'Regular fuel', lineTotal: 88.53, quantity: 23.12, price: 3.829 }],
    total: 88.53,
    currency: 'USD',
    payment: 'Visa ending 1234',
  });
  // It counts for the receipt that was opened, and no other.
  assert.equal(win.OHE.stores.costco.extractDetail(doc, { orderId: '21099900200222611051815' }), null);
});

test('costco views: each tab with the periods the range needs', () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const views = (range) => plain(win.OHE.stores.costco.views.list(win.document, { today: '2026-11-24', range }));
  assert.deepEqual(views({ from: '2026-10-01', to: '2026-11-24' }), ['warehouse|recent', 'online|recent']);
  // A period crossing the new year is named for the year it ends in.
  assert.deepEqual(views({ from: '2025-12-15', to: '2025-12-31' }), ['warehouse|2025-12', 'online|2025-12']);
  assert.deepEqual(views({ from: '2026-05-20', to: '2026-06-10' }), ['warehouse|2026-06', 'warehouse|2026-03', 'online|2026-06', 'online|2026-03']);
  assert.equal(views({ from: null, to: null }).length, 10);
  // While the page loads, the choices are briefly placeholders. The views don't depend on the wording.
  const select = win.document.getElementById('Showing');
  select.options[0].text = 'lastNMonths';
  select.options[1].text = '2026 june - august';
  assert.deepEqual(views({ from: '2026-08-01', to: '2026-11-24' }), ['warehouse|recent', 'warehouse|2026-06', 'online|recent', 'online|2026-06']);
  assert.equal(load().OHE.stores.costco.views.list(load().document, { range: {} }), null);
});

test('costco applies a view by choosing the tab, then the period', async () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const select = win.document.getElementById('Showing');
  let changes = 0;
  select.addEventListener('change', () => changes++);
  assert.equal(await win.OHE.stores.costco.views.apply(win.document, 'warehouse|recent'), true);
  assert.equal(changes, 0, 'already showing the recent period');
  // The new period's list arrives a moment after it's chosen.
  select.addEventListener('change', () => setTimeout(() => win.document.querySelector('[id^="viewRecieptBtn_"]').remove(), 100));
  assert.equal(await win.OHE.stores.costco.views.apply(win.document, 'warehouse|2026-03'), true);
  assert.equal(select.value, '2026 March - May');
  assert.equal(changes, 1);
  assert.equal(await win.OHE.stores.costco.views.apply(win.document, 'warehouse|2019-03'), false);
});

test('costco opens a receipt in place: its tab, its period, then View Receipt', async () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  const doc = win.document;
  // Start from the Online tab with no receipts showing, as the page first loads.
  const popup = doc.getElementById('receipt-popup');
  popup.remove();
  const panel = doc.getElementById('simple-tabpanel-1');
  const cards = [...panel.querySelectorAll('[id^="viewRecieptBtn_"]')].map((card) => card.parentElement);
  cards.forEach((card) => card.remove());
  const tab = doc.querySelector('[automation-id="myWarehouseOrdersTab"]');
  tab.setAttribute('aria-selected', 'false');
  const steps = [];
  tab.addEventListener('click', () => {
    steps.push('tab');
    tab.setAttribute('aria-selected', 'true');
  });
  const select = doc.getElementById('Showing');
  select.selectedIndex = 1;
  select.addEventListener('change', () => {
    steps.push(`period ${select.value}`);
    cards.forEach((card) => panel.append(card));
  });
  cards[0].querySelector('button').addEventListener('click', () => {
    steps.push('receipt');
    doc.body.append(popup);
  });

  const result = await win.OHE.run({ storeId: 'costco', mode: 'detail', order: { orderId: RECEIPT, date: '2026-11-20' }, today: '2026-11-24' });
  assert.deepEqual(steps, ['tab', 'period Last 3 Months', 'receipt']);
  assert.equal(result.status, 'ok');
  assert.equal(result.patch.total, 379.61);
  assert.equal(result.patch.items.length, 5);
});

test('costco gives up on an order the list no longer reaches', async () => {
  const win = load(fixture('costco-warehouse'), COSTCO_URL);
  win.document.getElementById('receipt-popup').remove();
  const result = await win.OHE.run({ storeId: 'costco', mode: 'detail', order: { orderId: '21099900100442001011200', date: '2020-01-01' }, today: '2026-11-24', timeoutMs: 300 });
  assert.equal(result.status, 'unparsed');
});

test('costco.com orders: list, and details with address, card and item prices', () => {
  const list = load(fixture('costco-online'), COSTCO_URL);
  const { orders } = plain(list.OHE.stores.costco.extractList(list.document, { today: '2026-11-24', range: {} }));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '1300000001');
  assert.equal(orders[0].date, '2026-09-18');
  assert.equal(orders[0].total, 582.98);
  assert.equal(orders[0].status, 'Delivered on 10/02/2026');

  const win = load(fixture('costco-online-detail'), COSTCO_URL);
  const store = win.OHE.stores.costco;
  assert.equal(store.openDetail(win.document, { orderId: '1300000001', date: '2026-09-18' }), true);
  const patch = plain(store.extractDetail(win.document, { orderId: '1300000001' }));
  assert.deepEqual(patch.items, [
    { name: "7.5' Test Pre-Lit Artificial Tree", url: 'https://www.costco.com/test-pre-lit-artificial-tree.product.100000001.html', price: 274.99, quantity: 2 },
  ]);
  assert.equal(patch.subtotal, 549.98);
  assert.equal(patch.shipping, 0);
  assert.equal(patch.tax, 33);
  assert.equal(patch.total, 582.98);
  assert.equal(patch.payment, 'Visa ending 1234');
  assert.equal(patch.deliveryAddress, '12 Test Orchard Dr SE Anytown, MI 49000-1234');
  assert.equal(patch.deliveryZip, '49000-1234');
  assert.equal(store.extractDetail(win.document, { orderId: '1300000002' }), null);
});

test('costco detects sign-in and a blocked page', () => {
  const win = load('<!doctype html><title>Access Denied</title><body></body>', COSTCO_URL);
  const store = win.OHE.stores.costco;
  assert.equal(store.detect(win.document, { hostname: 'www.costco.com', pathname: '/myaccount/' }), 'challenge');
  const ok = load(fixture('costco-online'), COSTCO_URL);
  assert.equal(store.detect(ok.document, { hostname: 'www.costco.com', pathname: '/myaccount/' }), null);
  assert.equal(store.detect(ok.document, { hostname: 'signin.costco.com', pathname: '/' }), 'login');
  assert.equal(store.detect(ok.document, { hostname: 'www.costco.com', pathname: '/LogonForm' }), 'login');
});

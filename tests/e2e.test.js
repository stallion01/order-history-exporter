// Loads the real extension in Chromium and runs a full export, with store sites
// replaced by the synthetic fixtures. This proves the mechanics (injection, paging,
// date filtering, sign-in pause, CSV download). It does not touch real accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');

const ROOT = path.join(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const html = (body) => ({ status: 200, contentType: 'text/html', body });
const EMPTY_API = JSON.stringify({ modules: { RIVER: [{ data: {} }] } });

async function launch() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/app/app.html`);
  await page.waitForSelector('input[name="store"]');
  return { context, page };
}

async function chooseStores(page, wanted, destination = 'csv') {
  await page.selectOption('#destination', destination);
  for (const box of await page.locator('input[name="store"]').all()) {
    await box.setChecked(wanted.includes(await box.getAttribute('value')));
  }
}

const TOKEN = 'e2e-token';

async function startDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohe-e2e-'));
  const db = openDatabase(path.join(dir, 'orders.db'));
  const app = buildApp({
    db,
    tokens: { get: () => TOKEN, rotate: () => TOKEN },
    allowedHosts: (host) => host.startsWith('127.0.0.1:'),
    webRoot: path.join(ROOT, 'web', 'dist'),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    db,
    url: `http://127.0.0.1:${app.server.address().port}`,
    async stop() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function connect(page, server) {
  await page.fill('#db-url', server.url);
  await page.fill('#db-token', TOKEN);
  await page.click('#db-test');
  await page.waitForFunction(() => document.getElementById('db-result').textContent === 'Connected.');
}

async function runExport(page) {
  await page.click('#start');
  await page.waitForFunction(() => document.getElementById('start').disabled, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(
    () => !document.getElementById('start').disabled && !document.getElementById('results').hidden,
    { timeout: 120000 }
  );
  return page.textContent('#results-title');
}

const listPage = (orders) => `<!doctype html><title>Your Orders</title><body>${orders
  .map(
    (o) => `<div class="order-card"><ul>
      <li><span>Order placed</span> <div>${o.date}</div></li>
      <li><span>Total</span> <div>${o.total}</div></li></ul>
      <div class="yohtmlc-order-id">Order # <span>${o.id}</span></div>
      <span class="delivery-box__primary-text">${o.status || 'Delivered'}</span>
      <div class="yohtmlc-product-title"><a href="/dp/${o.asin}">Item ${o.id}</a></div></div>`
  )
  .join('')}</body>`;
const orderIdOf = (url) => new URL(url).searchParams.get('orderID');

test('a second sync of an old period reads nothing again, except details still missing', { timeout: 240000 }, async () => {
  const server = await startDatabase();
  const { context, page } = await launch();
  const visits = { lists: 0, details: [] };
  let detailWorks = false;
  try {
    await context.route('https://www.amazon.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('order-details')) {
        const id = orderIdOf(url);
        visits.details.push(id);
        // One order's details fail the first time, to leave something missing.
        if (id.startsWith('333') && !detailWorks) return route.fulfill(html('<!doctype html><body>Unavailable</body>'));
        return route.fulfill(html(fixture('amazon-detail.html')));
      }
      if (route.request().resourceType() === 'document') visits.lists++;
      return route.fulfill(html(fixture(url.includes('startIndex') ? 'amazon-list-2.html' : 'amazon-list.html')));
    });
    await chooseStores(page, ['amazon'], 'database');
    await connect(page, server);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2024-01-01');
    await page.fill('#to', '2024-12-31');

    assert.match(await runExport(page), /^3 new orders/);
    assert.equal(visits.lists, 2);
    assert.equal(visits.details.length, 3);
    assert.equal(server.db.listOrders({}).total, 3);
    assert.equal(server.db.syncPlan('amazon', { from: '2024-01-01', to: '2024-12-31' }).pendingDetails.length, 1);

    // Second run: the period is fully read, so only the one failed order is opened.
    visits.lists = 0;
    visits.details = [];
    detailWorks = true;
    assert.match(await runExport(page), /^0 new orders/);
    assert.equal(visits.lists, 0, 'order lists are not read again');
    assert.deepEqual(visits.details, ['333-3333333-3333333']);
    assert.equal(server.db.syncPlan('amazon', { from: '2024-01-01', to: '2024-12-31' }).pendingDetails.length, 0);

    // Third run: nothing at all left to do, so no store page is opened.
    visits.details = [];
    assert.match(await runExport(page), /^0 new orders/);
    assert.equal(visits.lists, 0);
    assert.deepEqual(visits.details, []);
    assert.match(await page.textContent('#progress-list'), /already up to date/);
    assert.equal(await page.getAttribute('#open-reports', 'href'), `${server.url}/`);

    // A wider period reads only the part never read.
    await page.fill('#from', '2023-01-01');
    visits.lists = 0;
    await runExport(page);
    assert.ok(visits.lists >= 1, 'the unread year is listed');
    const covered = server.db.coverage('amazon');
    assert.equal(covered.length, 1);
    assert.equal(covered[0].from, '2023-01-01');
  } finally {
    await context.close();
    server.stop();
  }
});

test('a repeat sync of a recent period adds new orders and re-reads changed ones only', { timeout: 180000 }, async () => {
  const server = await startDatabase();
  const { context, page } = await launch();
  const today = new Date();
  const longDate = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const first = { id: '111-0000000-0000001', date: longDate, total: '$10.00', asin: 'B000000011', status: 'Shipped' };
  const second = { id: '111-0000000-0000002', date: longDate, total: '$20.00', asin: 'B000000012' };
  let shown = [first];
  let details = [];
  try {
    await context.route('https://www.amazon.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('order-details')) {
        details.push(orderIdOf(url));
        return route.fulfill(html('<!doctype html><body><div id="orderDetails"><p>Grand Total:</p><p>$10.00</p></div></body>'));
      }
      return route.fulfill(html(listPage(shown)));
    });
    await chooseStores(page, ['amazon'], 'database');
    await connect(page, server);
    await page.selectOption('#preset', 'this-year');

    assert.match(await runExport(page), /^1 new order,/);
    assert.deepEqual(details, [first.id]);

    // A new order appears: only it is opened.
    details = [];
    shown = [second, first];
    assert.match(await runExport(page), /^1 new order,/);
    assert.deepEqual(details, [second.id]);
    assert.equal(server.db.listOrders({}).total, 2);

    // Nothing changed: the recent list is re-checked, but no order is opened.
    details = [];
    assert.match(await runExport(page), /^0 new orders, 0 updated/);
    assert.deepEqual(details, []);

    // The first order's status changes: it is updated and re-read.
    details = [];
    shown = [second, { ...first, status: 'Delivered' }];
    assert.match(await runExport(page), /^0 new orders, 1 updated/);
    assert.deepEqual(details, [first.id]);
    assert.equal(server.db.listOrders({ q: first.id }).orders[0].status, 'Delivered');
  } finally {
    await context.close();
    server.stop();
  }
});

test('stopping early keeps what was read, and marks the period as not finished', { timeout: 120000 }, async () => {
  const server = await startDatabase();
  const { context, page } = await launch();
  try {
    await context.route('https://www.amazon.com/**', (route) => route.fulfill(html(fixture('amazon-list.html'))));
    await chooseStores(page, ['amazon'], 'database');
    await connect(page, server);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2024-01-01');
    await page.fill('#to', '2024-12-31');
    await page.click('#start');
    await page.waitForFunction(() => /[1-9]\d* new/.test(document.getElementById('progress-list').textContent), { timeout: 30000 });
    await page.click('#stop');
    await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
    assert.match(await page.textContent('#results-note'), /stopped early/);
    assert.equal(server.db.listOrders({}).total, 2);
    assert.deepEqual(server.db.coverage('amazon'), []);
  } finally {
    await context.close();
    server.stop();
  }
});

test('a wrong token or stopped server is reported before any store page opens', { timeout: 60000 }, async () => {
  const server = await startDatabase();
  const { context, page } = await launch();
  try {
    await chooseStores(page, ['amazon'], 'database');
    await page.selectOption('#preset', 'last-30');
    await page.click('#start');
    await page.waitForSelector('#form-error:not([hidden])');
    assert.match(await page.textContent('#form-error'), /access token/);

    await page.fill('#db-url', server.url);
    await page.fill('#db-token', 'wrong');
    await page.click('#start');
    await page.waitForFunction(() => /token/.test(document.getElementById('form-error').textContent) && !document.getElementById('start').disabled);
    assert.match(await page.textContent('#form-error'), /couldn't start.*token/i);
    assert.equal(context.pages().length, 2, 'no export window opened');
  } finally {
    await context.close();
    server.stop();
  }
});

test('the web app: first-run setup, reports, corrections, tax groups and phone layout', { timeout: 180000 }, async () => {
  const server = await startDatabase();
  const stores = [['amazon', 'Amazon'], ['walmart', 'Walmart'], ['homedepot', 'Home Depot'], ['newegg', 'Newegg']];
  const payments = ['Visa ending 1111', 'Mastercard ending 2222', 'PayPal'];
  const names = ['Stainless Steel Kettle', 'USB-C Cable 6 ft', 'Paint Roller Set', 'Graphics Card 16GB', '=Tricky <b>Name</b>'];
  for (let i = 0; i < 90; i++) {
    const [store, storeName] = stores[i % stores.length];
    const month = String((i % 12) + 1).padStart(2, '0');
    server.db.saveOrders(store, [
      {
        orderId: `T-${i}`,
        storeName,
        date: `${2025 + (i % 2)}-${month}-${String((i % 27) + 1).padStart(2, '0')}`,
        total: i % 17 === 0 ? -25 : 20 + ((i * 37) % 400),
        tax: 2 + (i % 9),
        payment: payments[i % payments.length],
        deliveryZip: i % 5 === 0 ? '02134' : '72712',
        status: 'Delivered',
        url: 'https://example.com/order',
        detailRead: i % 10 !== 0,
        items: [{ name: names[i % names.length], quantity: 1 + (i % 3) }],
      },
    ]);
  }
  server.db.addCoverage('amazon', [{ from: null, to: '2026-11-01' }]);
  server.db.recordRun('amazon', { newOrders: 1, complete: true });

  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true, colorScheme: 'light' });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  page.on('console', (msg) => msg.type() === 'error' && !/401|Failed to load resource/.test(msg.text()) && problems.push(msg.text()));
  const shots = process.env.E2E_SHOTS || ROOT;
  const nav = (name) => page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name });
  try {
    // First run: the owner account needs the setup code printed by the server.
    await page.goto(server.url);
    await page.getByRole('heading', { name: 'Create your account' }).waitFor();
    await page.getByLabel('Setup code').fill('not it');
    await page.getByLabel('Username').fill('owner');
    await page.getByLabel('Password', { exact: true }).fill('a long test password');
    await page.getByLabel('Confirm password').fill('a long test password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText("That setup code isn't right").waitFor();
    await page.getByLabel('Setup code').fill(TOKEN);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Dashboard.
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByText('$17,880.00').waitFor();
    assert.ok((await page.locator('svg[aria-label="Spending by month"] g[tabindex]').count()) > 12);
    assert.match(await page.textContent('main'), /Kitchen & Dining/);
    await page.screenshot({ path: path.join(shots, 'web-dashboard.png'), fullPage: true });

    // Orders: sort by ZIP, filter by category, and no store text is run as HTML.
    await nav('Orders').click();
    await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
    await page.waitForURL(/\/orders$/);
    await page.getByText('90 orders').waitFor();
    assert.equal(await page.locator('main b').count(), 0);
    await page.getByRole('button', { name: 'Delivery ZIP' }).click();
    await page.waitForFunction(() => document.querySelector('main table tbody tr td:nth-child(5)')?.textContent === '02134');
    await page.getByLabel('Category').selectOption('Office Supplies');
    await page.getByText('No orders match these filters.').waitFor();
    await page.getByLabel('Category').selectOption('');
    await page.getByLabel('Delivery ZIP').selectOption('02134');
    await page.getByText('18 orders').waitFor();
    await page.getByLabel('Delivery ZIP').selectOption('');

    // Items: a category change applies to every item with that name.
    await nav('Items').click();
    await page.getByRole('heading', { name: 'Items', exact: true }).waitFor();
    await page.getByText(/^90 items/).waitFor();
    await page.getByLabel('Search').fill('kettle');
    await page.getByText(/^18 items/).waitFor();
    await page.getByLabel('Category for Stainless Steel Kettle').first().selectOption('Office Supplies');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('select[aria-label="Category for Stainless Steel Kettle"]')].every((s) => s.value === 'Office Supplies')
    );
    await page.getByLabel('Search').fill('');
    await page.getByLabel('Delivery ZIP').selectOption('02134');
    await page.getByText(/^18 items/).waitFor();
    await page.getByRole('button', { name: 'Mark all as business' }).click();
    await page.getByRole('button', { name: 'Mark as business' }).click();
    await page.getByText('18 items marked business.').waitFor();
    await page.getByLabel('Delivery ZIP').selectOption('');
    await page.screenshot({ path: path.join(shots, 'web-items.png') });

    // Tax groups: a rule, the form lines, and a download.
    await nav('Tax groups').click();
    await page.getByRole('heading', { name: 'Tax groups' }).waitFor();
    await page.getByLabel('Tax year').selectOption('all');
    await page.getByLabel('When').selectOption('payment');
    await page.getByLabel('Value').selectOption('PayPal');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByText(/Payment method is\s*PayPal: Business/).waitFor();
    await page.getByRole('cell', { name: 'Office expense', exact: true }).waitFor();
    const [taxDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Summary CSV' }).click()]);
    assert.equal(taxDownload.suggestedFilename(), 'schedule-c_all-years_summary.csv');
    assert.match(fs.readFileSync(await taxDownload.path(), 'utf8'), /Schedule C,18,Office expense/);
    await page.screenshot({ path: path.join(shots, 'web-tax.png'), fullPage: true });

    // Settings: the extension's token is shown on request.
    await nav('Settings').click();
    await page.getByRole('button', { name: 'Show token' }).click();
    await page.getByText(TOKEN).waitFor();

    // Phone layout, dark mode: bottom tabs, no sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('navigation', { name: 'Main' }).last().getByRole('link', { name: 'Dashboard' }).click();
    await page.getByText('$17,880.00').waitFor();
    for (const route of ['/', '/orders', '/items', '/tax', '/settings']) {
      await page.goto(`${server.url}${route}`);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${route} scrolls sideways on a phone by ${overflow}px`);
    }
    await page.goto(`${server.url}/items`);
    await page.getByText(/^90 items/).waitFor();
    await page.screenshot({ path: path.join(shots, 'web-phone-items.png'), fullPage: false });
    await page.goto(server.url);
    await page.getByText('$17,880.00').waitFor();
    await page.screenshot({ path: path.join(shots, 'web-phone-dashboard.png'), fullPage: true });

    // Signing out, then back in.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    await page.getByLabel('Username').fill('owner');
    await page.getByLabel('Password').fill('a long test password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();

    assert.deepEqual(problems, []);
  } catch (err) {
    await page.screenshot({ path: path.join(shots, 'web-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.stop();
  }
});


test('exports two stores for a date range and downloads a correct CSV',{ timeout: 180000 }, async () => {
  const { context, page } = await launch();
  const visited = [];
  try {
    await context.route('https://www.amazon.com/**', (route) => {
      const url = route.request().url();
      visited.push(url);
      if (url.includes('order-details')) return route.fulfill(html(fixture('amazon-detail.html')));
      if (url.includes('startIndex')) return route.fulfill(html(fixture('amazon-list-2.html')));
      return route.fulfill(html(fixture('amazon-list.html')));
    });
    await context.route('https://www.ebay.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('/ajax/')) {
        const body = url.includes('page=1') ? fixture('ebay-api.json') : EMPTY_API;
        return route.fulfill({ status: 200, contentType: 'application/json', body });
      }
      return route.fulfill(html('<!doctype html><title>Purchase history</title><main>Purchases</main>'));
    });
    await context.route('https://order.ebay.com/**', (route) =>
      route.fulfill(html('<!doctype html><main><div><span>Tax</span><span>US $3.10</span></div><div><span>Order total</span><span>US $48.20</span></div></main>'))
    );

    await chooseStores(page, ['amazon', 'ebay']);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2024-02-01');
    await page.fill('#to', '2024-12-31');
    await page.click('#start');

    await page.waitForSelector('#results:not([hidden])', { timeout: 170000 });
    // Jan 15 falls outside the range; two Amazon orders and the eBay order remain.
    // Both Amazon orders get the same two-item detail fixture, and eBay has two items.
    assert.equal(await page.textContent('#results-title'), '3 orders, 6 items');
    assert.ok(visited.some((u) => u.includes('startIndex=10')), 'followed the next page');
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS || ROOT, 'e2e-results.png'), fullPage: true });

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    assert.equal(download.suggestedFilename(), 'orders_2024-02-01_to_2024-12-31.csv');
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(csv.startsWith('﻿Store,Order Date,Order ID'));
    assert.ok(csv.includes('2024-12-20'));
    assert.ok(!csv.includes('333-3333333-3333333'), 'order before the range is excluded');
    assert.ok(csv.includes("'=Formula Looking Cable"), 'formula-like text is neutralised');
    assert.ok(csv.includes('Vintage Film Camera'));
    assert.ok(csv.includes('48.2'), 'eBay detail page updated the total');
    assert.ok(csv.includes('30.17'), 'Amazon detail page added tax');
  } finally {
    await context.close();
  }
});

test('pauses at a sign-in page and resumes after Continue', { timeout: 120000 }, async () => {
  const { context, page } = await launch();
  let signedIn = false;
  try {
    await context.route('https://www.amazon.com/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/ap/signin') return route.fulfill(html('<!doctype html><title>Sign-In</title><form></form>'));
      if (!signedIn) return route.fulfill({ status: 302, headers: { location: 'https://www.amazon.com/ap/signin' } });
      return route.fulfill(html(fixture('amazon-list-2.html')));
    });
    await chooseStores(page, ['amazon']);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2024-01-01');
    await page.fill('#to', '2024-12-31');
    await page.uncheck('#details');
    await page.click('#start');

    await page.waitForSelector('#blocked:not([hidden])', { timeout: 60000 });
    assert.match(await page.textContent('#blocked-text'), /Amazon needs you to sign in/);
    signedIn = true;
    await page.click('#blocked-continue');
    await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
    assert.equal(await page.textContent('#results-title'), '1 order, 1 item');
  } finally {
    await context.close();
  }
});

test('Continue gets past a security check that was detected by mistake', { timeout: 120000 }, async () => {
  const { context, page } = await launch();
  try {
    // A readable order page that also carries the element Amazon's check looks for.
    const withCheck = fixture('amazon-list-2.html').replace(
      '<body>',
      '<body><form action="/errors/validateCaptcha" hidden></form>'
    );
    await context.route('https://www.amazon.com/**', (route) => route.fulfill(html(withCheck)));
    await chooseStores(page, ['amazon']);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2024-01-01');
    await page.fill('#to', '2024-12-31');
    await page.uncheck('#details');
    await page.click('#start');

    await page.waitForSelector('#blocked:not([hidden])', { timeout: 60000 });
    await page.click('#blocked-continue');
    await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
    assert.equal(await page.textContent('#results-title'), '1 order, 1 item');
  } finally {
    await context.close();
  }
});

test('refuses to start and explains when Chrome has not granted a store site', { timeout: 60000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(() => {
      globalThis.OHE.stores.homedepot.hosts = ['www.example.org'];
    });
    await chooseStores(page, ['homedepot']);
    await page.click('#start');
    await page.waitForSelector('#form-error:not([hidden])');
    assert.match(await page.textContent('#form-error'), /access to Home Depot.*reload arrow/);
    assert.equal(context.pages().length, 2, 'no export window opened');
    assert.ok(await page.locator('#progress').isHidden());
  } finally {
    await context.close();
  }
});

test('Home Depot sets its date filter on the page and pages with a button',{ timeout: 150000 }, async () => {
  const { context, page } = await launch();
  // A working imitation: the filter panel updates the label, and Next swaps in page two.
  const list = fixture('homedepot-list.html').replace(
    '</script>',
    `document.querySelectorAll('#panel button').forEach((b) => b.addEventListener('click', () => {
       if (b.textContent === 'View Results') { document.getElementById('panel').hidden = true; document.getElementById('date-open').textContent = 'Date Placed: Last 7 Years'; }
     }));
     document.querySelector('[aria-label="Skip to Next Page"]').addEventListener('click', (e) => {
       const body = document.querySelector('tbody');
       body.innerHTML = '<tr><td></td><td><img alt="Old Item"></td><td><a href="/myaccount/order-details?orderNumber=00009-99999"># 00009-99999</a></td><td>02/02/20</td><td></td><td><img alt="visa"><p>1111</p></td><td></td><td><p>$ 5.00</p></td><td></td></tr>';
       e.target.disabled = true;
     });
     </script>`
  );
  try {
    await context.route('https://www.homedepot.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('order-details')) return route.fulfill(html(fixture('homedepot-detail.html')));
      return route.fulfill(html(list));
    });
    await chooseStores(page, ['homedepot']);
    await page.selectOption('#preset', 'custom');
    await page.fill('#from', '2020-01-01');
    await page.fill('#to', '2026-12-31');
    await page.uncheck('#details');
    await page.click('#start');
    await page.waitForSelector('#results:not([hidden])', { timeout: 120000 });
    assert.match(await page.textContent('#results-title'), /^4 orders/);
    const preview = await page.textContent('#preview');
    assert.match(preview, /Mastercard ending 0027/);
    assert.match(preview, /2020-02-02/);
  } finally {
    await context.close();
  }
});

test('Newegg reads each year through its dropdown', { timeout: 120000 }, async () => {
  const { context, page } = await launch();
  const list = fixture('newegg-list.html').replace(
    '</body>',
    `<script>
     document.getElementById('date').addEventListener('change', (e) => {
       if (e.target.value === '2018') {
         document.querySelector('.order-item-info').textContent = '05/05/2018';
         document.querySelectorAll('strong.order-item-info')[1].textContent = '999888777';
       }
     });
     </script></body>`
  );
  try {
    await context.route('https://secure.newegg.com/**', (route) => route.fulfill(html(list)));
    await chooseStores(page, ['newegg']);
    await page.selectOption('#preset', 'all');
    await page.uncheck('#details');
    await page.click('#start');
    await page.waitForSelector('#results:not([hidden])', { timeout: 100000 });
    assert.match(await page.textContent('#results-title'), /^2 orders/);
    assert.match(await page.textContent('#preview'), /999888777/);
  } finally {
    await context.close();
  }
});

test('waits at a Walmart code page, then resumes and reads payment',{ timeout: 120000 }, async () => {
  const { context, page } = await launch();
  let verified = false;
  try {
    await context.route('https://www.walmart.com/**', (route) => {
      const url = route.request().url();
      if (!verified) return route.fulfill(html("<!doctype html><title>Verify</title><main><h1>Verify it's you</h1><p>We'll send a code by text or email.</p></main>"));
      if (/\/orders\/\d+/.test(url)) {
        return route.fulfill(html(fixture('walmart-detail.html').replace('</dl>', '</dl><div><h3>Payment method</h3><p>Visa ending in 4242</p></div>')));
      }
      return route.fulfill(html(fixture('walmart-list.html')));
    });
    await chooseStores(page, ['walmart']);
    await page.selectOption('#preset', 'all');
    await page.click('#start');

    await page.waitForSelector('#blocked:not([hidden])', { timeout: 60000 });
    assert.match(await page.textContent('#blocked-text'), /code by text or email/);
    verified = true;
    await page.click('#blocked-continue');
    await page.waitForSelector('#results:not([hidden])', { timeout: 90000 });
    assert.match(await page.textContent('#results-title'), /^2 orders/);
    assert.match(await page.textContent('#preview'), /Visa ending 4242/);
  } finally {
    await context.close();
  }
});

test('a page it cannot read is reported with a diagnostic, not silently empty', { timeout: 120000 }, async () => {
  const { context, page } = await launch();
  try {
    await context.route('https://www.walmart.com/**', (route) =>
      route.fulfill(html('<!doctype html><title>Purchase history</title><main><p>A redesigned page for Jo Smith</p></main>'))
    );
    await chooseStores(page, ['walmart']);
    await page.selectOption('#preset', 'last-30');
    await page.click('#start');
    await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
    assert.equal(await page.textContent('#results-title'), '0 orders, 0 items');
    assert.match(await page.textContent('.progress .warning'), /Couldn't read a Walmart order page/);
    assert.ok(await page.locator('#download').isDisabled());
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.progress .warning button')]);
    assert.ok(!fs.readFileSync(await download.path(), 'utf8').includes('Smith'));
  } finally {
    await context.close();
  }
});

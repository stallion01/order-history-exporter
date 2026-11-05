// Loads the real extension in Chromium and runs a full export, with store sites
// replaced by the synthetic fixtures. This proves the mechanics (injection, paging,
// date filtering, sign-in pause, CSV download). It does not touch real accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

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

async function chooseStores(page, wanted) {
  for (const box of await page.locator('input[name="store"]').all()) {
    await box.setChecked(wanted.includes(await box.getAttribute('value')));
  }
}

test('exports two stores for a date range and downloads a correct CSV', { timeout: 180000 }, async () => {
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

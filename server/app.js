// HTTP layer: the sync API for the extension, and the reports page.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OHE = require('./core');
const { FORMS, cents } = require('./tax');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_PAGE = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
const STORE_ID = /^[a-z0-9_-]{1,40}$/i;
const STATUSES = ['business', 'personal'];
const RULE_FIELDS = ['zip', 'payment', 'store', 'category'];
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// True for this machine and private home or office networks, not the public internet.
function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '').toLowerCase();
  if (ip === '::1') return true;
  if (/^(fc|fd|fe[89ab])[0-9a-f]{0,2}:/.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // shared range used by VPNs such as Tailscale
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_e) {
        reject(new HttpError(400, 'Request is not valid JSON.'));
      }
    });
  });
}

function dateParam(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (!DATE.test(value)) throw new HttpError(400, `${name} must look like YYYY-MM-DD.`);
  return value;
}

function storeParam(value) {
  if (!value || !STORE_ID.test(value)) throw new HttpError(400, 'A valid store is required.');
  return value;
}

function filtersFrom(query) {
  const store = query.get('store');
  const status = query.get('status') || null;
  if (status && ![...STATUSES, 'unreviewed'].includes(status)) throw new HttpError(400, 'Unknown status.');
  return {
    from: dateParam(query.get('from'), 'from'),
    to: dateParam(query.get('to'), 'to'),
    store: store ? storeParam(store) : null,
    payment: query.get('payment') || null,
    zip: query.get('zip') || null,
    category: query.get('category') || null,
    q: query.get('q') || null,
    status,
  };
}

function sortFrom(query) {
  return { sort: query.get('sort') || 'date', direction: query.get('dir') === 'asc' ? 'asc' : 'desc' };
}

function pageFrom(query) {
  return {
    limit: Math.min(Math.max(Number(query.get('limit')) || 50, 1), MAX_PAGE),
    offset: Math.max(Number(query.get('offset')) || 0, 0),
  };
}

function formParam(value) {
  if (!FORMS[value]) throw new HttpError(400, 'Unknown tax form.');
  return value;
}

function lineParam(form, value) {
  if (value === null || value === undefined || value === '') return null;
  if (!FORMS[form].lines.some(([line]) => line === String(value))) throw new HttpError(400, 'Unknown form line.');
  return String(value);
}

function textParam(value, name, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${name} is missing or too long.`);
  return text;
}

function taxFilters(query) {
  const year = query.get('year');
  if (year && !YEAR.test(year)) throw new HttpError(400, 'year must look like 2025.');
  return {
    from: year ? `${year}-01-01` : null,
    to: year ? `${year}-12-31` : null,
    zip: query.get('zip') || null,
    store: null,
    payment: null,
    q: null,
    category: null,
    status: null,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, value) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function sendCsv(res, filename, rows) {
  const body = `﻿${rows.map((row) => row.map(OHE.csvCell).join(',')).join('\r\n')}\r\n`;
  send(res, 200, body, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
}

const STATUS_LABELS = { business: 'Business', personal: 'Personal', unreviewed: 'Not reviewed' };

function itemRows(items, form) {
  const lineKey = form === 'schedule-e' ? 'scheduleE' : 'scheduleC';
  const labels = new Map(FORMS[form].lines);
  return [
    ['Order Date', 'Store', 'Order ID', 'Item', 'Category', 'Quantity', 'Item Price', 'Amount Paid', 'Amount Is Estimated', 'Delivery ZIP', 'Delivery Address', 'Payment Method', 'Business or Personal', `${FORMS[form].name} Line`, 'Line Description', 'Item URL', 'Order URL'],
    ...items.map((item) => [
      item.date,
      item.storeName,
      item.orderId,
      item.name,
      item.category,
      item.quantity,
      item.price,
      item.amount,
      item.estimated ? 'Yes' : 'No',
      item.deliveryZip,
      item.deliveryAddress,
      item.payment,
      STATUS_LABELS[item.status],
      item[lineKey],
      labels.get(item[lineKey]) || '',
      item.url,
      item.orderUrl,
    ]),
  ];
}

// allowedHosts: Host header values to accept, or a function that decides. Rejecting
// others stops a malicious website from reaching this server by pointing its own
// domain name at this machine. allowAnyClient lets public addresses connect, and
// is off by default so a mistaken port-forward doesn't expose your orders.
function createApp({ db, token, allowedHosts, allowAnyClient = false, tls = null }) {
  const hostAllowed = typeof allowedHosts === 'function' ? allowedHosts : (host) => allowedHosts.includes(host);

  const routes = {
    'GET /api/health': () => ({ ok: true }),

    'GET /api/status': () => db.status(),

    'GET /api/sync/plan': ({ query }) =>
      db.syncPlan(
        storeParam(query.get('store')),
        { from: dateParam(query.get('from'), 'from'), to: dateParam(query.get('to'), 'to') },
        { full: query.get('full') === '1' }
      ),

    'POST /api/orders': async ({ req }) => {
      const body = await readJson(req);
      if (!Array.isArray(body.orders)) throw new HttpError(400, 'orders must be a list.');
      return db.saveOrders(storeParam(body.store), body.orders);
    },

    'POST /api/sync/coverage': async ({ req }) => {
      const body = await readJson(req);
      if (!Array.isArray(body.ranges)) throw new HttpError(400, 'ranges must be a list.');
      const ranges = body.ranges.map((r) => {
        const to = dateParam(r.to, 'to');
        if (!to) throw new HttpError(400, 'Each range needs an end date.');
        return { from: dateParam(r.from, 'from'), to };
      });
      return { coverage: db.addCoverage(storeParam(body.store), ranges) };
    },

    'POST /api/sync/runs': async ({ req }) => {
      const body = await readJson(req);
      db.recordRun(storeParam(body.store), {
        from: dateParam(body.from, 'from'),
        to: dateParam(body.to, 'to'),
        newOrders: Number(body.newOrders) || 0,
        updatedOrders: Number(body.updatedOrders) || 0,
        detailsRead: Number(body.detailsRead) || 0,
        detailsMissed: Number(body.detailsMissed) || 0,
        complete: Boolean(body.complete),
      });
      return { ok: true };
    },

    'GET /api/report': ({ query }) => db.report(filtersFrom(query)),

    'GET /api/orders': ({ query }) => db.listOrders(filtersFrom(query), { ...sortFrom(query), ...pageFrom(query) }),

    'GET /api/items': ({ query }) => db.listItems(filtersFrom(query), { ...sortFrom(query), ...pageFrom(query) }),

    'GET /api/categories': () => ({
      categories: db.categoryList(),
      forms: Object.fromEntries(Object.entries(FORMS).map(([id, form]) => [id, { name: form.name, lines: form.lines }])),
    }),

    'POST /api/categories': async ({ req }) => {
      const body = await readJson(req);
      db.saveCategory({
        name: textParam(body.name, 'Category name', 60),
        scheduleC: lineParam('schedule-c', body.scheduleC),
        scheduleE: lineParam('schedule-e', body.scheduleE),
      });
      return { categories: db.categoryList() };
    },

    'POST /api/items/category': async ({ req }) => {
      const body = await readJson(req);
      const name = textParam(body.name, 'Item name', 1000);
      if (body.category === null || body.category === '') {
        db.setItemCategory(name, null);
      } else {
        const category = textParam(body.category, 'Category', 60);
        if (!db.categoryList().some((c) => c.name === category)) throw new HttpError(400, 'Unknown category.');
        db.setItemCategory(name, category);
      }
      return { ok: true };
    },

    // Marks listed items, or everything matching filters, as business or personal.
    'POST /api/items/status': async ({ req }) => {
      const body = await readJson(req);
      const status = body.status === null || body.status === 'unreviewed' ? null : body.status;
      if (status !== null && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
      let items;
      if (body.filters && typeof body.filters === 'object') {
        items = db.enrichedItems(filtersFrom(new URLSearchParams(Object.entries(body.filters).filter(([, v]) => v !== null && v !== undefined && v !== ''))));
      } else if (Array.isArray(body.items)) {
        items = body.items.map((item) => ({
          store: storeParam(item.store),
          orderId: textParam(item.orderId, 'Order', 200),
          name: textParam(item.name, 'Item name', 1000),
        }));
      } else {
        throw new HttpError(400, 'items or filters are required.');
      }
      db.markItems(items, status);
      return { changed: items.length };
    },

    'GET /api/tax/rules': () => ({ rules: db.taxRules() }),

    'POST /api/tax/rules': async ({ req }) => {
      const body = await readJson(req);
      if (!RULE_FIELDS.includes(body.field)) throw new HttpError(400, 'Unknown rule field.');
      if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
      db.saveTaxRule({ field: body.field, value: textParam(body.value, 'Rule value'), status: body.status });
      return { rules: db.taxRules() };
    },

    'POST /api/tax/rules/delete': async ({ req }) => {
      const body = await readJson(req);
      if (!Number.isInteger(body.id)) throw new HttpError(400, 'A rule id is required.');
      db.deleteTaxRule(body.id);
      return { rules: db.taxRules() };
    },

    'GET /api/tax/report': ({ query }) => db.taxReport(formParam(query.get('form')), taxFilters(query)),
  };

  function exportResponse(url, res) {
    const query = url.searchParams;
    if (url.pathname === '/api/export.csv') {
      const layout = query.get('layout') === 'orders' ? 'orders' : 'items';
      const { orders } = db.listOrders(filtersFrom(query), sortFrom(query));
      send(res, 200, OHE.toCsv(orders, layout), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="orders.csv"',
        'Cache-Control': 'no-store',
      });
      return true;
    }
    if (url.pathname === '/api/items.csv') {
      const form = FORMS[query.get('form')] ? query.get('form') : 'schedule-c';
      sendCsv(res, 'items.csv', itemRows(db.listItems(filtersFrom(query), sortFrom(query)).items, form));
      return true;
    }
    if (url.pathname === '/api/tax/export.csv') {
      const form = formParam(query.get('form'));
      const filters = taxFilters(query);
      if (query.get('detail') === 'summary') {
        const report = db.taxReport(form, filters);
        const year = query.get('year') || 'All years';
        const rows = [
          ['Tax Year', 'Form', 'Line', 'Description', 'Amount', 'Items', 'Items With Estimated Amounts', 'Note'],
          ...report.lines.map((line) => [year, report.formName, line.line, line.label, line.amount, line.items, line.estimated, line.note]),
          ...report.unassigned.map((entry) => [year, report.formName, 'Not assigned', entry.category, entry.amount, entry.items, '', 'Choose a form line for this category.']),
        ];
        rows.push([year, report.formName, 'Total', 'All business items', cents(report.totals.business), report.totals.businessItems, '', '']);
        sendCsv(res, 'tax-summary.csv', rows);
      } else {
        const items = db.enrichedItems({ ...filters, status: 'business' }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        sendCsv(res, 'tax-items.csv', itemRows(items, form));
      }
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://server.invalid');
    if (!allowAnyClient && !isPrivateAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, 'This server only accepts connections from private networks.');
    }
    if (!hostAllowed((req.headers.host || '').toLowerCase())) {
      throw new HttpError(403, 'This server is not configured for that address. See OHE_PUBLIC_HOST in the README.');
    }

    if (!url.pathname.startsWith('/api/')) {
      const file = STATIC_FILES[url.pathname];
      if (req.method !== 'GET' || !file) throw new HttpError(404, 'Not found.');
      send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file[0])), { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      return;
    }

    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!given || !sameSecret(given, token)) throw new HttpError(401, 'The access token is missing or wrong.');

    if (req.method === 'GET' && exportResponse(url, res)) return;

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'Not found.');
    sendJson(res, 200, await route({ req, query: url.searchParams }));
  }

  const listener = (req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'The server hit an error. See its console.' : err.message });
      else res.end();
    });
  };
  return tls ? https.createServer(tls, listener) : http.createServer(listener);
}

module.exports = { createApp, isPrivateAddress };

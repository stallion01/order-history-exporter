// Phase 5: year-end summary by Schedule line, expense classes, the asset register,
// possible capital purchases, and the package (Excel, PDF, ZIP with receipts).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { unzip, zip } = require('../server/dist/cpa/zip');
const { fileSecretBox } = require('../server/dist/secrets');

let dir;
let db;
let app;
let base;
let cookie;
let elm;
let consulting;

const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();
const tx = async (q) => (await get(`/api/bank/transactions?preset=all&kind=all&q=${encodeURIComponent(q)}`)).transactions[0];

async function fakeReader() {
  return {
    model: 'stand-in',
    inputTokens: 0,
    outputTokens: 0,
    reading: { is_receipt: true, vendor: 'Shell', date: '2026-03-12', currency: 'USD', subtotal: null, tax: null, tip: null, total: 40, card_last4: null, payment_method: null, category: null, items: [], confidence: 'high', notes: null },
  };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-cpa-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true, secrets: fileSecretBox(dir), dataDir: dir, receiptReader: fakeReader });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];

  elm = (await post('/api/entities', { name: 'Elm St rental', kind: 'rental' })).id;
  consulting = (await post('/api/entities', { name: 'Consulting LLC', kind: 'business' })).id;
  await post('/api/places/entity', { zip: '01845', entityId: elm });

  // A fridge and paper towels for the rental, bought on Amazon in one order.
  await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify({
      store: 'amazon',
      orders: [
        {
          orderId: 'A9',
          date: '2026-02-01',
          total: 2630,
          deliveryZip: '01845',
          deliveryAddress: '45 Elm Street North Andover, MA 01845',
          items: [
            { name: 'Refrigerator French Door', price: 2600, quantity: 1 },
            { name: 'Paper Towels', price: 30, quantity: 1 },
          ],
        },
      ],
    }),
  });

  const card = await post('/api/bank/import', {
    fileName: 'card.csv',
    content: [
      'Date,Description,Amount',
      '02/03/2026,AMZN Mktp US*FRIDGE,-2630.00',
      '03/12/2026,SHELL OIL 57444,-40.00',
      '04/02/2026,STAPLES 0123,-120.00',
      '05/09/2026,BIG APPLIANCE OUTLET,-3200.00',
      '06/01/2026,NETFLIX.COM,-15.49',
      '07/15/2026,AIRBNB PAYMENTS,1500.00',
    ].join('\n'),
    newAccount: { name: 'Business Visa', kind: 'credit', owner: 'business' },
  });
  await post(`/api/bank/accounts/${card.accountId}`, { entityId: consulting });
  await post('/api/bank/transactions/update', { ids: [(await tx('NETFLIX')).id], status: 'personal' });
  await post('/api/bank/transactions/update', { ids: [(await tx('STAPLES')).id], category: 'Office Supplies' });
  await post('/api/bank/transactions/update', { ids: [(await tx('AIRBNB')).id], entity: elm, category: 'Rental Income' });
  await post('/api/bank/transactions/update', { ids: [(await tx('APPLIANCE')).id], category: 'Appliances', entity: elm });

  // An owner draw: business checking to personal savings.
  await post('/api/bank/import', { content: 'Date,Description,Amount\n08/01/2026,ONLINE TRANSFER TO SAVINGS,-500.00\n', newAccount: { name: 'Business Checking', kind: 'checking', owner: 'business' } });
  await post('/api/bank/import', { content: 'Date,Description,Amount\n08/02/2026,ONLINE TRANSFER FROM CHECKING,500.00\n', newAccount: { name: 'Personal Savings', kind: 'savings', owner: 'personal' } });

  // A receipt for the fuel.
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('shell receipt   ')]);
  await post('/api/receipts', { originalHash: crypto.createHash('sha256').update(photo).digest('hex'), data: photo.toString('base64') });
  await app.receipts.kick();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the ZIP writer round-trips files, compressed or stored', () => {
  const big = Buffer.from('a'.repeat(5000));
  const random = crypto.randomBytes(300);
  const out = unzip(zip([{ name: 'text.txt', data: big }, { name: 'folder/bin.dat', data: random }, { name: 'é.txt', data: Buffer.from('x') }]));
  assert.deepEqual(out.map((e) => e.name), ['text.txt', 'folder/bin.dat', 'é.txt']);
  assert.deepEqual(out[0].data, big);
  assert.deepEqual(out[1].data, random);
});

test('the summary has each entity on its Schedule, with income and personal left out', async () => {
  const { summary } = await get('/api/cpa/summary?year=2026');
  const byName = Object.fromEntries(summary.map((g) => [g.entity, g]));
  assert.equal(byName['Elm St rental'].form, 'E');
  assert.equal(byName['Consulting LLC'].form, 'C');
  assert.equal(byName['Elm St rental'].income, 1500);
  // Fuel is line 9 on Schedule C; office supplies line 18.
  const consultingLines = Object.fromEntries(byName['Consulting LLC'].lines.map((l) => [l.line, l.amount]));
  assert.equal(consultingLines['9'], 40);
  assert.equal(consultingLines['18'], 120);
  // Netflix was personal: not on any Schedule.
  assert.equal(byName['Consulting LLC'].personal, 15.49);
});

test('purchases of $2,500 or more are flagged, whole charges and single order items', async () => {
  const { possibleCapital } = await get('/api/cpa/summary?year=2026');
  assert.deepEqual(possibleCapital.map((p) => [p.item || p.payee, p.amount]), [
    ['Big Appliance Outlet', 3200],
    ['Refrigerator French Door', 2600],
  ]);

  // The fridge is a capital asset of the rental; the outlet purchase was repairs, not capital.
  const fridge = possibleCapital.find((p) => p.item);
  await post('/api/cpa/capital/confirm', { key: fridge.key, recovery: '5' });
  await post('/api/cpa/capital/dismiss', { key: possibleCapital.find((p) => !p.item).key });
  const after = await get('/api/cpa/summary?year=2026');
  assert.deepEqual(after.possibleCapital, []);
  assert.deepEqual(after.assets.map((a) => [a.description, a.cost, a.recovery, a.entity]), [['Refrigerator French Door', 2600, '5', 'Elm St rental']]);
  const rental = after.summary.find((g) => g.entity === 'Elm St rental');
  assert.equal(rental.capex, 2600);
  assert.equal(rental.opex, 3230, 'the paper towels and the outlet purchase stay expenses');
  await assert.rejects(post('/api/cpa/capital/confirm', { key: fridge.key }), /already on the asset register/);

  // Whole transactions can go on the register too.
  const { id } = await post('/api/assets', { transactionId: (await tx('STAPLES')).id, recovery: '7', description: 'Office chair' });
  assert.ok(id);
  await post(`/api/assets/${id}/delete`);
});

test('a category can be cost of goods sold', async () => {
  await post('/api/categories', { name: 'Office Supplies', scheduleC: '18', scheduleE: '15', expenseClass: 'cogs' });
  const { summary } = await get('/api/cpa/summary?year=2026');
  assert.equal(summary.find((g) => g.entity === 'Consulting LLC').cogs, 120);
  await post('/api/categories', { name: 'Office Supplies', scheduleC: '18', scheduleE: '15', expenseClass: 'opex' });
});

test('the workbook has every sheet, lines, income, assets and owner draws', async () => {
  const response = await call('/api/cpa/workbook.xlsx?year=2026');
  assert.match(response.headers.get('content-disposition'), /Business Hub 2026\.xlsx/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(book.worksheets.map((w) => w.name), ['Summary', 'Monthly by category', 'Transactions', 'Income', 'Assets', 'Transfers', 'Needs review']);
  const values = (name) => book.getWorksheet(name).getSheetValues().slice(2).filter(Boolean).map((row) => row.slice(1));
  const lines = values('Transactions');
  const fridge = lines.find((r) => r[3] === 'Refrigerator French Door');
  assert.equal(fridge[6], 'Capital purchase');
  assert.equal(fridge[11], 2600);
  assert.ok(lines.some((r) => r[2] === 'Netflix' && r[6] === 'Personal'));
  assert.equal(values('Income')[0][5], 1500);
  assert.equal(values('Assets')[0][0], 'Refrigerator French Door');
  const draw = values('Transfers').find((r) => r[4] === 'Owner draw');
  assert.equal(draw[3], 500);
  const summaryText = JSON.stringify(values('Summary'));
  assert.match(summaryText, /Elm St rental — Schedule E/);
});

test('the PDF and the package with receipts named by date, vendor and amount', async () => {
  const pdf = Buffer.from(await (await call('/api/cpa/summary.pdf?year=2026')).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

  const response = await call('/api/cpa/package.zip?year=2026');
  assert.match(response.headers.get('content-disposition'), /CPA package 2026\.zip/);
  const entries = unzip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['Year-end summary 2026.pdf', 'Business Hub 2026.xlsx', 'receipts/2026-03-12_Shell_40.00.jpg']);

  // One entity's package: its own lines only.
  const one = unzip(Buffer.from(await (await call(`/api/cpa/package.zip?year=2026&entity=${elm}`)).arrayBuffer()));
  assert.equal(one.length, 2, 'the fuel receipt belongs to the consulting business');
  assert.equal((await call('/api/cpa/summary?year=20x6')).status, 400);
  assert.equal((await call('/api/cpa/summary?year=2026&entity=999')).status, 404);
});

test('review counts what is still to decide', async () => {
  const { review } = await get('/api/cpa/summary?year=2026');
  assert.equal(review.possibleCapital, 0);
  assert.equal(review.undecided, 0, 'every line is business or personal');
  assert.equal(review.unmatchedStoreCharges, 0);
});

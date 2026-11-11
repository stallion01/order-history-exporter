// Receipts: upload checks, reading (with a stand-in for Claude), matching to card
// transactions, cash purchases, and the API key setting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { ReaderError } = require('../server/dist/receipts/reader');
const { sniff } = require('../server/dist/receipts/service');
const { fileSecretBox } = require('../server/dist/secrets');

let dir;
let db;
let app;
let base;
let cookie;
const reads = [];

// Stand-in for Claude: the "photo" carries a label after the JPEG marker.
const READINGS = {
  hardware: { vendor: 'Home Depot', date: '2026-03-05', total: 84.1, tax: 5.5, card_last4: '4321', category: 'Building & Repair Materials' },
  diner: { vendor: 'Blue Plate Diner', date: '2026-03-09', total: 40, tax: 3, card_last4: null, category: 'Meals' },
  cash: { vendor: 'Farmers Market', date: '2026-03-10', total: 12.5, tax: null, card_last4: null, category: null },
  later: { vendor: 'Corner Store', date: '2026-03-20', total: 9.99, tax: null, card_last4: null, category: null },
};
async function fakeReader(file) {
  const label = file.data.subarray(3).toString('latin1').trim();
  reads.push(label);
  if (label === 'nokey') throw new ReaderError('Add an Anthropic API key in Settings to read receipts automatically, or fill in the details yourself.');
  if (label === 'blurry') throw new ReaderError('The receipt could not be read automatically. Fill in the details yourself.');
  const r = READINGS[label];
  if (!r) throw new ReaderError('The receipt could not be read automatically. Fill in the details yourself.');
  return {
    model: 'claude-opus-5-5',
    inputTokens: 1500,
    outputTokens: 300,
    reading: {
      is_receipt: true,
      currency: 'USD',
      subtotal: null,
      tip: null,
      payment_method: null,
      items: [{ description: 'Something', quantity: 1, unit_price: r.total, amount: r.total }],
      confidence: 'high',
      notes: null,
      ...r,
      date: r.date,
    },
  };
}

const photo = (label) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label.padEnd(16, ' '), 'latin1')]);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();
const upload = (label, extra = {}) => {
  const data = photo(label);
  return post('/api/receipts', { fileName: `${label}.jpg`, originalHash: sha(data), data: data.toString('base64'), ...extra });
};
const settled = () => app.receipts.kick();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-receipts-'));
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

  // A card with a few March charges.
  const csv = 'Date,Description,Amount\n03/06/2026,HOME DEPOT #2345,-84.10\n03/09/2026,BLUE PLATE DINER,-48.00\n03/09/2026,SHELL OIL 123,-40.00\n';
  await post('/api/bank/import', { content: csv, fileName: 'card.csv', newAccount: { name: 'Business Visa', kind: 'credit', owner: 'business' } });
  db.raw.prepare("UPDATE bank_accounts SET last4 = '4321'").run();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only real photos and PDFs are accepted, and only by a signed-in user', async () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7 something')), 'application/pdf');
  assert.equal(sniff(Buffer.from('<html><script>')), null);
  const fake = Buffer.from('<svg onload=alert(1)>   ');
  await assert.rejects(post('/api/receipts', { originalHash: sha(fake), data: fake.toString('base64') }), /not a photo/);
  const anonymous = await fetch(`${base}/api/receipts`);
  assert.equal(anonymous.status, 401);
});

test('a receipt is read, matched to its card charge, and gives the charge its category', async () => {
  const { id, duplicate } = await upload('hardware');
  assert.equal(duplicate, false);
  await settled();
  const { receipt } = await get(`/api/receipts/${id}`);
  assert.equal(receipt.status, 'read');
  assert.equal(receipt.vendor, 'Home Depot');
  assert.equal(receipt.transaction.payee, 'Home Depot');
  assert.equal(receipt.matchSource, 'auto');
  const tx = (await get('/api/bank/transactions?q=home%20depot&preset=all')).transactions[0];
  assert.equal(tx.receiptId, id);
  assert.equal(tx.category, 'Building & Repair Materials');

  // The same photo again is recognised, not stored twice.
  assert.equal((await upload('hardware')).duplicate, true);
  assert.equal(reads.filter((r) => r === 'hardware').length, 1);

  // The file is served back as it was stored.
  const file = await call(`/api/receipts/${id}/file`);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), photo('hardware'));
  assert.equal((await fetch(`${base}/api/receipts/${id}/file`)).status, 401);
});

test('a tip makes the charge higher than the receipt: suggested, not linked automatically', async () => {
  const { id } = await upload('diner');
  await settled();
  const { receipt, suggestions } = await get(`/api/receipts/${id}`);
  assert.equal(receipt.transactionId, null);
  assert.equal(suggestions[0].payee, 'Blue Plate Diner');
  assert.equal(suggestions[0].amount, -48);
  // A $40 charge from another payee the same day is offered, but lower, and wasn't linked.
  assert.equal(suggestions[1].payee, 'Shell Oil');
  await post(`/api/receipts/${id}/link`, { transactionId: suggestions[0].id });
  assert.equal((await get(`/api/receipts/${id}`)).receipt.transaction.amount, -48);
  // Another receipt can't take the same transaction.
  const other = await upload('cash');
  await settled();
  await assert.rejects(post(`/api/receipts/${other.id}/link`, { transactionId: suggestions[0].id }), /already attached/);
});

test('a cash purchase becomes a transaction in a Cash account', async () => {
  const id = (await get('/api/receipts?q=farmers')).receipts[0].id;
  await post(`/api/receipts/${id}/cash`);
  const { receipt } = await get(`/api/receipts/${id}`);
  assert.equal(receipt.transaction.account, 'Cash');
  assert.equal(receipt.transaction.amount, -12.5);
  await assert.rejects(post(`/api/receipts/${id}/cash`), /already attached/);
});

test('a receipt waits for a charge that arrives later', async () => {
  const { id } = await upload('later');
  await settled();
  assert.equal((await get(`/api/receipts/${id}`)).receipt.transactionId, null);
  await post('/api/bank/import', { content: 'Date,Description,Amount\n03/21/2026,CORNER STORE 77,-9.99\n', accountId: 1 });
  assert.equal((await get(`/api/receipts/${id}`)).receipt.transaction.payee, 'Corner Store 77');
});

test('problems: no key waits, an unreadable receipt needs a person, edits by hand count', async () => {
  const waiting = await upload('nokey');
  const blurry = await upload('blurry');
  await settled();
  let r = (await get(`/api/receipts/${waiting.id}`)).receipt;
  assert.equal(r.status, 'pending');
  assert.match(r.readError, /API key/);
  // "Try later" stops the run, so the next receipt waits too.
  assert.equal((await get(`/api/receipts/${blurry.id}`)).receipt.status, 'pending');
  await post(`/api/receipts/${waiting.id}/delete`);
  await settled();
  r = (await get(`/api/receipts/${blurry.id}`)).receipt;
  assert.equal(r.status, 'failed');
  const list = await get('/api/receipts?view=review');
  assert.ok(list.receipts.some((x) => x.id === blurry.id));

  // Filled in by hand: read, checked, and matched.
  const { receipt } = await post(`/api/receipts/${blurry.id}`, { vendor: 'Shell', date: '2026-03-09', total: 40 });
  assert.equal(receipt.status, 'read');
  assert.equal(receipt.checked, true);
  assert.equal(receipt.transaction.payee, 'Shell Oil');

  // Unlinked by hand stays unlinked.
  await post(`/api/receipts/${blurry.id}/unlink`);
  app.receipts.matchUnlinked();
  assert.equal((await get(`/api/receipts/${blurry.id}`)).receipt.transactionId, null);
  assert.equal((await call(`/api/receipts/${waiting.id}`)).status, 404, 'deleted');
});

test('receipts are grouped by month, vendor or category, and filtered by each', async () => {
  // Another Home Depot receipt, written differently, read in a different month.
  await post('/api/receipts/1', { checked: true });
  const extra = photo('hardware-april');
  const { id } = await post('/api/receipts', { originalHash: sha(extra), data: extra.toString('base64') });
  await post(`/api/receipts/${id}`, { vendor: 'THE HOME DEPOT #0456', date: '2026-04-02', total: 19.99, category: 'Tools & Hardware' });

  const byMonth = await get('/api/receipts?group=month');
  assert.deepEqual(byMonth.groups.map((g) => g.label).slice(0, 2), ['April 2026', 'March 2026']);
  assert.equal(byMonth.receipts[0].id, id, 'newest month first');

  const byVendor = await get('/api/receipts?group=vendor');
  const depot = byVendor.groups.find((g) => g.label === 'Home Depot');
  assert.equal(depot.count, 2, 'both spellings are one vendor');
  assert.equal(depot.total, 104.09);
  assert.deepEqual(byVendor.groups.map((g) => g.label), [...byVendor.groups.map((g) => g.label)].sort((a, b) => a.localeCompare(b)));

  assert.equal((await get('/api/receipts?vendor=Home%20Depot')).total, 2);
  assert.equal((await get('/api/receipts?vendor=Home%20Depot&years=2026&from=2026-04-01')).total, 1);
  assert.equal((await get('/api/receipts?category=Meals')).total, 1);
  assert.equal((await get('/api/receipts?category=Meals&category=Tools%20%26%20Hardware')).total, 2);
  const uncategorised = await get('/api/receipts?category=none&group=category');
  assert.ok(uncategorised.receipts.every((r) => r.category === null));
  assert.equal(uncategorised.groups[0].label, 'No category');
  assert.equal((await get('/api/receipts?years=2025')).total, 0);

  const { choices } = byMonth;
  assert.deepEqual(choices.years, ['2026']);
  assert.equal(choices.vendors.find((v) => v.name === 'Home Depot').count, 2);
  assert.ok(choices.categories.some((c) => c.name === 'Meals'));
  assert.equal((await call('/api/receipts?group=size')).status, 400);
});

test('a receipt knows its neighbours in the list, and the next one still to check', async () => {
  const { receipts: list } = await get('/api/receipts?group=month&limit=200');
  assert.ok(list.length >= 3);
  const ids = list.map((r) => r.id);
  const middle = await get(`/api/receipts/${ids[1]}/nav?group=month`);
  assert.deepEqual([middle.position, middle.total, middle.prev, middle.next], [2, ids.length, ids[0], ids[2]]);

  // The next unchecked one after this, wrapping round to the start.
  const unchecked = list.filter((r) => !r.checked && r.id !== ids[1]);
  const after = [...list.slice(2), ...list.slice(0, 1)].find((r) => !r.checked);
  assert.equal(middle.toCheck, unchecked.length);
  assert.equal(middle.nextToCheck, after ? after.id : null);

  const first = await get(`/api/receipts/${ids[0]}/nav?group=month`);
  assert.equal(first.prev, null);
  const last = await get(`/api/receipts/${ids.at(-1)}/nav?group=month`);
  assert.equal(last.next, null);

  // Opened from a filtered list it isn't in: no position, start from the top.
  const outside = await get(`/api/receipts/${ids[0]}/nav?years=2025`);
  assert.deepEqual([outside.position, outside.total, outside.prev, outside.next, outside.nextToCheck], [null, 0, null, null, null]);

  // Once everything is checked there is nothing left to go to.
  for (const r of list) if (!r.checked) await post(`/api/receipts/${r.id}`, { checked: true });
  assert.deepEqual(await get(`/api/receipts/${ids[1]}/nav?group=month`).then((n) => [n.nextToCheck, n.toCheck]), [null, 0]);
  for (const r of list) if (!r.checked) await post(`/api/receipts/${r.id}`, { checked: false });
});

test('the nightly backup copies receipt files, once', () => {
  const { backup } = require('../server/dist/backup');
  const { copyReceipts } = require('../server/dist/backup');
  backup(dir, 2);
  const stored = fs.readdirSync(path.join(dir, 'backups', 'receipts'), { recursive: true }).filter((f) => /.jpg$/.test(f));
  assert.ok(stored.length >= 3);
  assert.equal(copyReceipts(path.join(dir, 'receipts'), path.join(dir, 'backups', 'receipts')), 0, 'nothing new the second time');
});

test('the Anthropic API key is stored encrypted and never shown again', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(post('/api/settings/anthropic', { apiKey: 'not-a-key' }), /sk-ant-/);
  const key = `sk-ant-api03-${'x'.repeat(40)}abcd`;
  const status = await post('/api/settings/anthropic', { apiKey: key });
  assert.deepEqual([status.set, status.endsWith], [true, 'abcd']);
  const stored = db.raw.prepare("SELECT value FROM app_settings WHERE key = 'anthropic.apiKey'").get().value;
  assert.ok(!stored.includes('sk-ant'));
  assert.ok(!JSON.stringify(await get('/api/settings/anthropic')).includes('xxxx'));
  assert.equal((await post('/api/settings/anthropic/delete')).set, false);
});

// Putting a file import right: the account a CSV is guessed for, undoing an import,
// and moving one to the account it should have gone to. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { fileSecretBox } = require('../server/dist/secrets');

let dir;
let db;
let app;
let base;
let cookie;
let one;
let two;

const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();
const csv = (rows) => ['Date,Description,Amount', ...rows].join('\n');
const count = async (accountId) => (await get('/api/bank/accounts')).accounts.find((a) => a.id === accountId).transactions;

// January for each account, then a February file for account two that repeats three of its January rows.
const ONE_JAN = csv(['01/02/2026,COFFEE CART,-4.50', '01/03/2026,PAYROLL DEPOSIT,1000.00', '01/05/2026,HARDWARE BARN,-50.00']);
const TWO_JAN = csv(['01/04/2026,GROCERY TOWN,-80.00', '01/06/2026,RENT RECEIVED,2000.00', '01/08/2026,FUEL STOP,-40.00']);
const TWO_FEB = csv(['01/04/2026,GROCERY TOWN,-80.00', '01/06/2026,RENT RECEIVED,2000.00', '01/08/2026,FUEL STOP,-40.00', '02/01/2026,GROCERY TOWN,-60.00', '02/03/2026,FUEL STOP,-35.00']);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-imports-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true, secrets: fileSecretBox(dir), dataDir: dir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  one = (await post('/api/bank/import', { content: ONE_JAN, fileName: 'one-jan.csv', newAccount: { name: 'Checking One', kind: 'checking', owner: 'business' } })).accountId;
  two = (await post('/api/bank/import', { content: TWO_JAN, fileName: 'two-jan.csv', newAccount: { name: 'Checking Two', kind: 'checking', owner: 'business' } })).accountId;
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a CSV's account is the one whose transactions it overlaps, not just the last to use its columns", async () => {
  const inspect = await post('/api/bank/import/inspect', { content: TWO_FEB });
  assert.equal(inspect.accountId, two);
  assert.equal(inspect.accountReason, 'overlap');
  assert.equal(inspect.overlap, 3);
  // A file that overlaps nothing, with columns both accounts use: the user chooses.
  const fresh = await post('/api/bank/import/inspect', { content: csv(['03/01/2026,NEW SHOP,-12.00']) });
  assert.equal(fresh.accountId, null);
  assert.equal(fresh.accountReason, 'shared-layout');
});

test('an import put in the wrong account is moved, matching what the right one already has', async () => {
  const wrong = await post('/api/bank/import', { content: TWO_FEB, fileName: 'two-feb.csv', accountId: one });
  assert.equal(wrong.added, 5);
  assert.equal(await count(one), 8);

  const listed = (await get('/api/bank/imports')).imports;
  assert.equal(listed[0].id, wrong.importId);
  assert.equal(listed[0].account, 'Checking One');
  const detail = await get(`/api/bank/imports/${wrong.importId}`);
  assert.equal(detail.replayable, true);
  assert.equal(detail.rows.added, 5);

  const moved = await post(`/api/bank/imports/${wrong.importId}/move`, { accountId: two });
  assert.equal(moved.replayed, true);
  assert.equal(moved.moved, 2);
  assert.equal(moved.merged, 3);
  assert.equal(await count(one), 3);
  assert.equal(await count(two), 5);
  // The import now belongs to the right account.
  assert.equal((await get(`/api/bank/imports/${moved.importId}`)).account, 'Checking Two');
  await assert.rejects(post(`/api/bank/imports/${moved.importId}/move`, { accountId: two }), /already in that account/);

  // And it can be undone: only what it added goes.
  const undone = await post(`/api/bank/imports/${moved.importId}/undo`);
  assert.equal(undone.removed, 2);
  assert.equal(await count(two), 3);
  assert.equal((await call(`/api/bank/imports/${moved.importId}`)).status, 404);
});

test('an older import, from before files were kept, still moves what it added', async () => {
  const wrong = await post('/api/bank/import', { content: TWO_FEB, fileName: 'two-feb.csv', accountId: one });
  db.raw.prepare('DELETE FROM bank_import_lines WHERE import_id = ?').run(wrong.importId);
  assert.equal((await get(`/api/bank/imports/${wrong.importId}`)).replayable, false);
  const moved = await post(`/api/bank/imports/${wrong.importId}/move`, { accountId: two });
  assert.equal(moved.replayed, false);
  assert.equal(moved.moved, 2);
  assert.equal(moved.merged, 3);
  assert.equal(await count(one), 3);
  assert.equal(await count(two), 5);
  // Importing the file again into the right account adds nothing more.
  const again = await post('/api/bank/import', { content: TWO_FEB, fileName: 'two-feb.csv', accountId: two });
  assert.equal(again.added, 0);
});

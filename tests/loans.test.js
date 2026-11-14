// Loans whose balance the user keeps: each new payment asks for its principal, which
// comes off the balance and splits the payment into principal and interest. Made-up data.
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
const all = async (q = '') => (await get(`/api/bank/transactions?kind=all&preset=all&limit=200${q}`)).transactions;
const account = async (name) => (await get('/api/bank/accounts')).accounts.find((a) => a.name === name);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-loans-'));
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
  await post('/api/bank/import', {
    content: 'Date,Description,Amount\n05/01/2026,LOAN PAYMENT,-2000.00\n06/01/2026,LOAN PAYMENT,-2000.00\n',
    fileName: 'checking.csv',
    newAccount: { name: 'Checking', kind: 'checking', owner: 'business' },
  });
  await post('/api/bank/import', {
    content: 'Date,Description,Amount\n05/01/2026,REGULAR PAYMENT,2000.00\n06/01/2026,REGULAR PAYMENT,2000.00\n',
    fileName: 'loan.csv',
    newAccount: { name: 'Building loan', kind: 'other', owner: 'business' },
  });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a loan with a balance you keep asks for the principal of each new payment', async () => {
  const loan = await account('Building loan');
  // Tracking starts after May's payment, so only June's asks.
  await assert.rejects(post(`/api/loans/${loan.id}`, { tracked: true, balance: 300000, splitAccountId: loan.id }), /split account/);
  const tracked = await post(`/api/loans/${loan.id}`, { tracked: true, balance: 300000, asOf: '2026-05-15' });
  assert.equal(tracked.loans[0].balance, 300000);
  assert.deepEqual(tracked.pending.map((p) => [p.date, p.amount]), [['2026-06-01', 2000]]);
  assert.equal((await account('Building loan')).kind, 'loan', 'it is now a loan');

  // Debt in net worth, not cash.
  const flow = await get('/api/pl/cashflow');
  assert.equal(flow.netWorth.debt, 300000);

  const june = tracked.pending[0].transactionId;
  await assert.rejects(post(`/api/loans/payments/${june}/record`, { principal: 2500 }), /no more than the payment/);
  const done = await post(`/api/loans/payments/${june}/record`, { principal: 450.25 });
  assert.equal(done.balance, 299549.75);
  assert.equal(done.interest, 1549.75);
  assert.deepEqual(done.pending, []);
  assert.equal((await get('/api/pl/cashflow')).netWorth.debt, 299549.75);

  // Split into principal (a transfer) and interest (an expense); checking's payment set aside.
  const split = await all('&q=Mortgage');
  assert.deepEqual(split.map((t) => [t.amount, t.kind, t.category]).sort(), [
    [-1549.75, 'normal', 'Mortgage Interest'],
    [-450.25, 'transfer', 'Loan & Mortgage Payments'],
  ]);
  const checking = (await all()).filter((t) => t.account === 'Checking');
  assert.deepEqual(checking.map((t) => [t.posted, t.kind]).sort(), [['2026-05-01', 'transfer'], ['2026-06-01', 'ignored']]);
  // The loan's side stays a loan payment, not income.
  const loanSide = (await all()).find((t) => t.id === june);
  assert.deepEqual([loanSide.kind, loanSide.category], ['transfer', 'Loan & Mortgage Payments']);
  assert.equal((await get('/api/bank/spending?preset=all')).byMonth.find((m) => m.month === '2026-06').income, 0);

  // Undo puts everything back.
  await post(`/api/loans/payments/${june}/undo`);
  assert.equal((await account('Building loan')).balance, 300000);
  assert.equal((await all('&q=Mortgage')).length, 0);
  assert.equal((await all()).find((t) => t.account === 'Checking' && t.posted === '2026-06-01').kind, 'normal');
  assert.equal((await get('/api/loans')).pending.length, 1);

  // Already counted: no change, and it stops asking.
  await post(`/api/loans/payments/${june}/skip`);
  const after = await get('/api/loans');
  assert.equal(after.pending.length, 0);
  assert.equal(after.loans[0].balance, 300000);
});

test('bank interest and laundry income are their own income sources', async () => {
  await post('/api/bank/import', {
    // Debit and credit columns, so which way each went isn't guessed.
    content: 'Date,Description,Debit,Credit\n07/01/2026,INTEREST CREDIT,,12.34\n07/03/2026,ELM LAUNDRY COLLECTION,,250.00\n07/05/2026,CASH DEPOSIT,,40.00\n07/06/2026,HARDWARE STORE,15.00,\n',
    fileName: 'checking-july.csv',
    newAccount: { name: 'Second checking', kind: 'checking', owner: 'business' },
  });
  const july = (await get('/api/bank/spending?preset=all')).byMonth.find((m) => m.month === '2026-07');
  assert.equal(july.sources.interest, 12.34);
  assert.equal(july.sources.laundry, 250);
  assert.equal(july.sources.other, 40);
  const laundry = await get('/api/bank/transactions?preset=all&direction=in&source=laundry');
  assert.deepEqual(laundry.transactions.map((t) => t.amount), [250]);
  const pl = await get('/api/pl?preset=all');
  if (pl.sources) assert.ok(pl.sources.some((s) => s.key === 'interest' && s.amount === 12.34));
});

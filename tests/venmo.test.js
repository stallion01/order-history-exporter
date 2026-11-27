// Venmo statements in My money: reading the CSV, importing into each person's own
// Venmo account, and pairing what Venmo took from the bank with the bank's line.
// All names, amounts and accounts here are made up.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { parseVenmoStatement } = require('../server/dist/bank/venmo');

let dir;
let db;
let app;
let base;
let cookie;

const call = (route, options = {}, as = cookie) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie: as, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}, as = cookie) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) }, as);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route, as = cookie) => (await call(route, {}, as)).json();

const month = new Date().toISOString().slice(0, 7);
const lastMonth = (() => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
})();
const day = (d) => `${lastMonth}-${String(d).padStart(2, '0')}`;
const us = (d) => `${lastMonth.slice(5)}/${String(d).padStart(2, '0')}/${lastMonth.slice(0, 4)}`;

// A statement as Venmo writes it: a title, the column names after an empty first
// column, a balance row, the payments, a closing balance row and a long disclaimer.
const DISCLAIMER = '"In case of errors or questions about your\n        electronic transfers:\n        - Telephone us\n        "';
function statement(handle, begin, end, rows) {
  const lines = [
    `Account Statement - (@${handle}) ,,,,,,,,,,,,,,,,,,,,,`,
    'Account Activity,,,,,,,,,,,,,,,,,,,,,',
    ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer',
    `,,,,,,,,,,,,,,,,$${begin.toFixed(2)},,,,,`,
    ...rows.map(
      (r) => `,${r.id},${r.when}T12:00:00,${r.type ?? 'Payment'},${r.status ?? 'Complete'},${r.note ?? ''},${r.from},${r.to},${r.amount},,0,,0,,${r.funding ?? ''},${r.destination ?? ''},,,,Venmo,,`,
    ),
    `,,,,,,,,,,,,,,,,,$${end.toFixed(2)},$0.00,,$0.00,${DISCLAIMER}`,
    '',
  ];
  return lines.join('\n');
}

const ownerStatement = statement('Owner-Test', 0, 0, [
  // Paid from checking: Venmo took it from the bank, which shows "VENMO PAYMENT".
  { id: '1001', when: day(3), note: 'Dinner split', from: 'Owner Test', to: 'Pat Example', amount: '- $40.00', funding: 'EXAMPLE BANK Personal Checking *4321' },
  // A friend paying back, kept in the Venmo balance.
  { id: '1002', when: day(4), note: 'Uber', from: 'Pat Example', to: 'Owner Test', amount: '+ $25.00', destination: 'Venmo balance' },
  // Paid from the balance: never reaches the bank.
  { id: '1003', when: day(5), note: 'Movie', from: 'Owner Test', to: 'Sam Example', amount: '- $10.00' },
  { id: '1004', when: day(6), type: 'Merchant Transaction', from: 'Owner Test', to: 'Example Cinema Inc', amount: '- $20.00', funding: 'Venmo balance' },
  // A payment received straight into the bank.
  { id: '1005', when: day(7), note: 'Tickets', from: 'Lee Example', to: 'Owner Test', amount: '+ $30.00', destination: 'EXAMPLE BANK Personal Checking *4321' },
  { id: '1006', when: day(8), status: 'Pending', note: 'Later', from: 'Owner Test', to: 'Pat Example', amount: '- $5.00' },
  // Kept in the balance, then sent to the bank.
  { id: '1007', when: day(9), note: 'Gift', from: 'Kim Example', to: 'Owner Test', amount: '+ $20.00', destination: 'Venmo balance' },
  { id: '1008', when: day(10), type: 'Standard Transfer', from: '', to: '', amount: '- $15.00', destination: 'EXAMPLE BANK Personal Checking *4321' },
]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-venmo-'));
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
  // The owner's checking, with Venmo's lines in it as the bank words them.
  const rows = [
    'Date,Description,Amount',
    `${us(4)},VENMO PAYMENT 1040000000001 WEB ID: 3000000001,-40.00`,
    `${us(8)},VENMO DES:CASHOUT ID:1040000000002 INDN:OWNER TEST CO ID:5000000001 PPD,30.00`,
    `${us(11)},VENMO DES:CASHOUT ID:1040000000003 INDN:OWNER TEST CO ID:5000000001 PPD,15.00`,
    `${us(12)},GROCERY STORE 12,-60.00`,
    '',
  ];
  await post('/api/bank/import', { content: rows.join('\n'), fileName: 'checking.csv', newAccount: { name: 'Owner checking', kind: 'checking', owner: 'personal' } });
  const { accounts } = await get('/api/bank/accounts');
  db.raw.prepare('UPDATE bank_accounts SET last4 = ? WHERE id = ?').run('4321', accounts.find((a) => a.name === 'Owner checking').id);
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Venmo statement is read row by row, and adds up to its balance', () => {
  const s = parseVenmoStatement(ownerStatement);
  assert.equal(s.handle, '@Owner-Test');
  assert.equal(s.beginning, 0);
  assert.equal(s.ending, 0);
  assert.ok(s.balanced);
  assert.deepEqual(
    s.transactions.map((t) => [t.externalId, t.amount]),
    [
      ['1001:fund', 40],
      ['1001', -40],
      ['1002', 25],
      ['1003', -10],
      ['1004', -20],
      ['1005', 30],
      ['1005:bank', -30],
      ['1007', 20],
      ['1008:bank', -15],
    ],
  );
  assert.equal(s.transactions[1].description, 'Venmo to Pat Example: Dinner split');
  assert.equal(s.transactions[1].payee, 'Pat Example');
  assert.equal(s.transactions[4].description, 'Example Cinema Inc');
  assert.deepEqual(
    s.skipped.map((r) => r.reason),
    ['it is pending'],
  );
  assert.throws(() => parseVenmoStatement('Date,Description,Amount\n1/1/2026,X,1\n'), /not a Venmo statement/);
});

test('importing makes a Venmo account, pairs it with the bank, and counts Venmo-only payments', async () => {
  const status = await get('/api/personal/venmo');
  assert.equal(status.account, null);
  const r = await post('/api/personal/venmo/import', { files: [{ name: 'VenmoStatement.csv', content: ownerStatement }] });
  assert.equal(r.created, true);
  assert.equal(r.added, 9);
  assert.equal(r.matchedToBank, 3);
  assert.equal(r.leftOut.length, 1);
  assert.deepEqual(r.unbalanced, []);
  assert.ok(r.status.lastImport);

  const { transactions } = await get('/api/bank/transactions?preset=all&kind=all&limit=100');
  const find = (text) => transactions.find((t) => t.description.includes(text));
  // The bank's Venmo lines are transfers to and from Venmo, not spending or income.
  for (const text of ['VENMO PAYMENT', 'ID:1040000000002', 'ID:1040000000003']) assert.equal(find(text).kind, 'transfer', text);
  assert.equal(find('Venmo paid from').kind, 'transfer');
  assert.equal(find('Venmo to Pat Example').kind, 'normal');

  // In My money: the dinner, the movie and the cinema are spending, once each, and the
  // friend paying back their share of the dinner takes it off; the bank's Venmo lines
  // and the cash-out aren't counted at all.
  const summary = await get(`/api/personal?month=${lastMonth}`);
  assert.equal(summary.detail.spent, 60 + (40 - 25) + 10 + 20);
  assert.ok(summary.accounts.some((a) => a.name === 'Venmo'));
  const people = summary.detail.groups.find((g) => g.key === 'people');
  assert.equal(people.amount, 40 - 25 + 10, 'paid to people through Venmo, less what came back');

  // The same statement again adds nothing.
  const again = await post('/api/personal/venmo/import', { files: [{ name: 'VenmoStatement.csv', content: ownerStatement }] });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 9);
});

test('a bank line that arrives after the statement is still paired', async () => {
  const late = statement('Owner-Test', 0, 0, [
    { id: '2001', when: day(20), note: 'Lunch', from: 'Owner Test', to: 'Pat Example', amount: '- $12.00', funding: 'EXAMPLE BANK Personal Checking *4321' },
  ]);
  await post('/api/personal/venmo/import', { files: [{ name: 'late.csv', content: late }] });
  let fund = (await get('/api/bank/transactions?preset=all&kind=all&limit=100')).transactions.find((t) => t.description.startsWith('Venmo paid from') && t.amount === 12);
  assert.equal(fund.kind, 'transfer', 'a transfer even before the bank shows it');
  const { accounts } = await get('/api/bank/accounts');
  await post('/api/bank/import', {
    content: ['Date,Description,Amount', `${us(22)},VENMO PAYMENT 1040000000009 WEB ID: 3000000001,-12.00`, ''].join('\n'),
    fileName: 'checking2.csv',
    accountId: accounts.find((a) => a.name === 'Owner checking').id,
  });
  const after = (await get('/api/bank/transactions?preset=all&kind=all&limit=100')).transactions;
  fund = after.find((t) => t.description.startsWith('Venmo paid from') && t.amount === 12);
  const bankLine = after.find((t) => t.description.includes('1040000000009'));
  assert.equal(bankLine.kind, 'transfer');
  assert.equal(bankLine.transferId, fund.id);
});

test("each person imports into their own Venmo, and a payment between two family members' Venmo is a transfer", async () => {
  const { id: kid } = await post('/api/people', { name: 'Kid Example' });
  await post(`/api/people/${kid}/login`, { username: 'kidv', password: 'kid test password' });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ username: 'kidv', password: 'kid test password' }),
  });
  const kidCookie = login.headers.get('set-cookie').split(';')[0];

  // Someone else's statements can't go into theirs, nor theirs into someone else's.
  await assert.rejects(post('/api/personal/venmo/import', { files: [{ name: 'x.csv', content: ownerStatement }] }, kidCookie), { status: 409 });

  const kidStatement = statement('Kid-Test', 0, 40, [{ id: '1001', when: day(3), note: 'Dinner split', from: 'Owner Test', to: 'Kid Example', amount: '+ $40.00', destination: 'Venmo balance' }]);
  const r = await post('/api/personal/venmo/import', { files: [{ name: 'kid.csv', content: kidStatement }], person: 999 }, kidCookie);
  assert.equal(r.account.name, 'Kid Venmo');
  assert.equal(r.added, 1);
  const theirs = await get(`/api/personal?month=${lastMonth}`, kidCookie);
  assert.deepEqual(
    theirs.accounts.map((a) => a.name),
    ['Kid Venmo'],
  );
  assert.equal((await get('/api/personal/venmo', kidCookie)).account.name, 'Kid Venmo');

  // The owner's payment to them is now money between family, on both sides.
  const owners = (await get('/api/bank/transactions?preset=all&kind=all&limit=100')).transactions.filter((t) => t.description.includes('Dinner split'));
  assert.equal(owners.length, 2);
  assert.ok(owners.every((t) => t.kind === 'transfer'));
  const mine = await get(`/api/personal?month=${lastMonth}`);
  // Sent to family 40; to people, the movie and the lunch less Pat's 25 back.
  assert.equal(mine.detail.spent, 60 + 20 + 40 + (10 + 12 - 25), 'the dinner is now money sent to family');
  assert.ok(mine.family.some((f) => f.amount === -40));

  // Statements from two Venmo accounts at once are refused.
  await assert.rejects(
    post(
      '/api/personal/venmo/import',
      {
        files: [
          { name: 'a.csv', content: kidStatement },
          { name: 'b.csv', content: ownerStatement },
        ],
      },
      kidCookie,
    ),
    { status: 400 },
  );
});

test("a Venmo sync key imports into its own person's Venmo only, and nothing else", async () => {
  const { key } = await post('/api/personal/venmo/key', {});
  assert.match(key, /^vsk_/);
  const withKey = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { authorization: `Bearer ${key}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const status = await (await withKey('/api/personal/venmo')).json();
  assert.equal(status.account.name, 'Venmo');
  assert.ok(status.hasKey);
  // Not the books, nor someone else's money.
  for (const route of ['/api/bank/transactions', '/api/personal', '/api/people']) assert.equal((await withKey(route)).status, 403, route);
  assert.equal((await withKey('/api/personal/venmo/key', { method: 'POST', body: '{}' })).status, 403);
  const kid = (await get('/api/people')).people.find((p) => p.name === 'Kid Example').id;
  const asOwnerKey = await withKey('/api/personal/venmo/import', { method: 'POST', body: JSON.stringify({ files: [{ name: 'x.csv', content: ownerStatement }], person: kid }) });
  assert.equal((await asOwnerKey.json()).account.name, 'Venmo', "the owner's key still imports into the owner's Venmo");

  // A new key replaces the old one; removing it stops it.
  const { key: second } = await post('/api/personal/venmo/key', {});
  assert.equal((await withKey('/api/personal/venmo')).status, 401);
  await post('/api/personal/venmo/key/delete', {});
  assert.equal((await fetch(`${base}/api/personal/venmo`, { headers: { authorization: `Bearer ${second}` } })).status, 401);
});

test("the extension fetches the signed-in Venmo account's statement and sends it with the key", async () => {
  const kid = (await get('/api/people')).people.find((p) => p.name === 'Kid Example').id;
  const { key } = await post('/api/personal/venmo/key', { person: kid });
  global.self = global;
  delete global.OHE;
  require('../src/lib/venmo.js');
  const asked = [];
  const csv = statement('Kid-Test', 40, 52, [{ id: '3001', when: day(15), note: 'Coffee', from: 'Lee Example', to: 'Kid Example', amount: '+ $12.00', destination: 'Venmo balance' }]);
  const realFetch = global.fetch;
  // venmo.com, signed in; the Hub is the test server.
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://account.venmo.com/statement')) {
      return { ok: true, url: 'https://account.venmo.com/statement?accountType=personal&profileId=123', text: async () => '<html></html>' };
    }
    if (String(url).startsWith('https://account.venmo.com/api/statement/download')) {
      asked.push(new URL(url).searchParams);
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/csv' }), text: async () => csv };
    }
    return realFetch(url, options);
  };
  try {
    const result = await global.OHE.venmoSync({ url: base, key }, { now: new Date(`${month}-27T12:00:00Z`) });
    assert.equal(result.added, 1);
    assert.equal(asked[0].get('profileId'), '123');
    assert.equal(asked[0].get('csv'), 'true');
    // It picks up from two weeks before the newest payment already here.
    assert.equal(asked[0].get('startDate'), new Date(Date.parse(day(3) + 'T12:00:00Z') - 14 * 86400000).toISOString().slice(0, 10));
    assert.equal(asked[0].get('endDate'), `${month}-27`);
    assert.match(global.OHE.describeVenmoSync(result), /Added 1 Venmo row/);

    // Signed out of venmo.com: said plainly.
    global.fetch = async (url, options) => (String(url).startsWith('https://account.venmo.com') ? { ok: true, url: 'https://id.venmo.com/signin', text: async () => '' } : realFetch(url, options));
    await assert.rejects(global.OHE.venmoSync({ url: base, key }), /Sign in to venmo.com/);
  } finally {
    global.fetch = realFetch;
  }
});

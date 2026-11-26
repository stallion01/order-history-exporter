// The personal money dashboard: money in, money out and money only moved, grouped
// by kind, with typical months, regular payments, budgets and a look ahead.
// Made-up data only, placed relative to the current month so it never goes stale.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { businessPattern, classify, seriesKey } = require('../server/dist/personal/groups');

let dir;
let db;
let app;
let base;
let cookie;
let checkingId;

const call = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();

const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const thisMonth = new Date().toISOString().slice(0, 7);
const lastMonth = addMonths(thisMonth, -1);
const usDate = (month, day) => `${month.slice(5)}/${String(day).padStart(2, '0')}/${month.slice(0, 4)}`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-personal-'));
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

  // Six complete months of the same paycheck, rent, groceries and streaming, plus a
  // monthly move to a brokerage. Last month also has one payment nothing recognises.
  const rows = ['Date,Description,Amount'];
  for (let i = 6; i >= 1; i--) {
    const m = addMonths(thisMonth, -i);
    rows.push(`${usDate(m, 1)},OAK STREET APTS RENT,-2000.00`);
    rows.push(`${usDate(m, 5)},NETFLIX.COM,-15.99`);
    rows.push(`${usDate(m, 10)},WHOLE FOODS MARKET 123,-300.00`);
    rows.push(`${usDate(m, 15)},EXAMPLE CORP PAYROLL PPD ID: 999,5000.00`);
    rows.push(`${usDate(m, 20)},FIDELITY MONEYLINE,-1000.00`);
    rows.push(`${usDate(m, 3)},SIDE GIG LLC PPD ID: 7,250.00`);
    rows.push(`${usDate(m, 25)},SIDE GIG LLC PPD ID: 7,250.00`);
  }
  rows.push(`${usDate(lastMonth, 12)},XYZQ THING 42,-50.00`);
  rows.push(`${usDate(thisMonth, 1)},OAK STREET APTS RENT,-2000.00`);
  rows.push('');
  await post('/api/bank/import', { content: rows.join('\n'), fileName: 'checking.csv', newAccount: { name: 'Everyday checking', kind: 'checking', owner: 'personal' } });

  const card = ['Date,Description,Amount', `${usDate(lastMonth, 8)},AMAZON MKTPLACE,-100.00`, ''].join('\n');
  await post('/api/bank/import', { content: card, fileName: 'card.csv', newAccount: { name: 'Rewards card', kind: 'credit', owner: 'personal' } });

  const { accounts } = await get('/api/bank/accounts');
  checkingId = accounts.find((a) => a.name === 'Everyday checking').id;
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('payments are sorted into money in, money out and money moved', () => {
  assert.deepEqual(classify({ amount: 5000, description: 'EXAMPLE CORP PAYROLL PPD ID: 1' }), { flow: 'in', group: 'pay', guessed: true });
  assert.equal(classify({ amount: -2000, description: 'OAK STREET APTS RENT' }).group, 'home');
  assert.equal(classify({ amount: -40, description: 'Zelle payment to Pat Example' }).group, 'people');
  assert.deepEqual(classify({ amount: -1000, description: 'FIDELITY MONEYLINE' }), { flow: 'move', group: 'invested', guessed: true });
  assert.equal(classify({ amount: 1000, description: 'SCHWAB BROKERAGE' }).group, 'from_savings');
  // The owner's category wins over the description, and money back on a purchase is less spending.
  assert.deepEqual(classify({ amount: -60, description: 'XYZQ THING', category: 'Grocery' }), { flow: 'out', group: 'food', guessed: false });
  assert.deepEqual(classify({ amount: 25, description: 'STORE CREDIT', category: 'Clothing' }), { flow: 'out', group: 'shopping', guessed: false });
  // A category of the owner's own for pay is income, even one made as an expense; an
  // income category of their own is sorted by the description; another is still a refund.
  for (const category of ['w2 salary', 'Wages', 'W-2 Pay', 'Paychecks']) {
    assert.deepEqual(classify({ amount: 3000, description: 'EXAMPLE CORP DES:PAYROLL', category }), { flow: 'in', group: 'pay', guessed: false }, category);
  }
  assert.deepEqual(classify({ amount: 400, description: 'Zelle payment from Pat Example', category: 'Tutoring' }, null, new Set(['Tutoring'])), { flow: 'in', group: 'people_in', guessed: false });
  assert.deepEqual(classify({ amount: 400, description: 'XYZQ', category: 'Tutoring' }, null, new Set(['Tutoring'])), { flow: 'in', group: 'other_in', guessed: false });
  assert.equal(classify({ amount: 30, description: 'XYZQ', category: 'Kids Sports' }).flow, 'out', 'money back under a spending category of their own');
  assert.equal(classify({ amount: -30, description: 'PAYPAL *SHOP', category: 'w2 salary' }).flow, 'out');
  // A tax refund is money in, whatever spending-side category it was filed under.
  for (const category of [null, 'Refunds & Returns', 'Taxes & Licenses']) {
    assert.deepEqual(classify({ amount: 2300, description: 'IRS TREAS 310 DES: TAX REF ID:1', payee: 'Irs Treas', category }), { flow: 'in', group: 'refunds', guessed: !category }, String(category));
  }
  assert.equal(classify({ amount: 800, description: 'State of Ill ILSTTAXRFD PPD ID: 1' }).group, 'refunds');
  assert.equal(classify({ amount: 800, description: 'IRS TREAS 310 TAX REF', category: 'Other Income' }).group, 'other_in', 'an income category the owner chose still wins');
  assert.equal(classify({ amount: -500, description: 'IRS USATAXPYMT', category: 'Taxes & Licenses' }).group, 'taxes', 'tax paid is still spending');
  // A transfer to one of the owner's business accounts is money moved, by its last four.
  const business = businessPattern(['1234']);
  assert.deepEqual(classify({ amount: -500, description: 'Online transfer to CHK ...1234' }, business), { flow: 'move', group: 'business', guessed: true });
  assert.equal(classify({ amount: -500, description: 'Online transfer to CHK ...9999' }, business).group, 'between');
  assert.equal(businessPattern([]), null);
  // The same payee next month has the same key; payments to people are keyed by who.
  assert.equal(seriesKey('EXAMPLE CORP PAYROLL PPD ID: 1'), seriesKey('EXAMPLE CORP PAYROLL PPD ID: 2'));
  assert.equal(seriesKey('Zelle payment to Pat Example Conf# 1'), 'person pat example');
});

test('a past month shows what came in, where it went and what was only moved', async () => {
  const data = await get(`/api/personal?month=${lastMonth}`);
  assert.equal(data.month, lastMonth);
  assert.equal(data.future, false);
  const d = data.detail;
  assert.equal(d.earned, 5500);
  assert.equal(d.spent, 2465.99);
  assert.equal(d.kept, 3034.01);
  const group = (key) => d.groups.find((g) => g.key === key);
  assert.equal(group('home').amount, 2000);
  assert.equal(group('food').amount, 300);
  assert.equal(group('subscriptions').amount, 15.99);
  assert.equal(group('shopping').amount, 100);
  assert.equal(group('other').amount, 50);
  assert.deepEqual(d.moves, [{ key: 'invested', amount: -1000 }]);
  assert.equal(d.sources[0].key, 'pay');
  assert.equal(d.unsorted, 3); // the odd payment and the two side-gig payments
  // The link to give them a category opens just those payments.
  const linked = await get(`/api/bank/transactions?preset=all&kind=all&${d.unsortedIds.map((id) => `id=${id}`).join('&')}`);
  assert.deepEqual(linked.transactions.map((t) => t.id).sort(), [...d.unsortedIds].sort());
  assert.equal(linked.total, 3);
  assert.equal(d.biggest[0].amount, -2000);
  assert.equal(d.pace.actual.length, d.pace.days);
  assert.equal(d.pace.actual[d.pace.days - 1], 2465.99);
  assert.ok(data.accounts.some((a) => a.name === 'Rewards card'));
});

test('typical months, regular payments and the year come from the history', async () => {
  const data = await get('/api/personal');
  assert.equal(data.month, thisMonth);
  assert.equal(data.typical.home, 2000);
  assert.equal(data.typical.food, 300);
  // One odd payment doesn't make a typical month.
  assert.equal(data.typical.other, 0);
  const payroll = data.recurring.find((r) => r.name === 'Example Corp Payroll');
  assert.equal(payroll.amount, 5000);
  assert.equal(payroll.day, 15);
  assert.ok(data.recurring.some((r) => r.group === 'home' && r.amount === -2000 && r.paidThisMonth));
  // A side gig paid on the 3rd and the 25th is two regular payments, not one of double.
  const gig = data.recurring.filter((r) => r.name === 'Side Gig LLC');
  assert.deepEqual(
    gig.map((r) => [r.day, r.amount]),
    [
      [3, 250],
      [25, 250],
    ],
  );
  // A brokerage move is never a regular bill.
  assert.ok(!data.recurring.some((r) => r.group === 'invested'));
  assert.equal(data.last12.to, lastMonth);
  assert.equal(data.last12.earned.find((g) => g.key === 'pay').amount, 30000);
  // A year back and six months ahead.
  assert.equal(data.months.length, 19);
  assert.equal(data.months.filter((m) => m.future).length, 6);
});

test('the months ahead are forecast from regular income and typical spending, then budgets', async () => {
  const ahead = addMonths(thisMonth, 2);
  let data = await get(`/api/personal?month=${ahead}`);
  assert.equal(data.future, true);
  assert.equal(data.detail.earned, 5500);
  assert.equal(data.detail.spent, 2315.99);
  assert.equal(data.months.find((m) => m.month === ahead).projectedSpent, 2315.99);

  const { budgets } = await post('/api/personal/budgets', { group: 'food', monthly: 400 });
  assert.deepEqual(budgets, { food: 400 });
  data = await get(`/api/personal?month=${ahead}`);
  assert.equal(data.detail.spent, 2415.99);
  assert.equal(data.detail.groups.find((g) => g.key === 'food').budget, 400);
  assert.equal(data.detail.pace.budget, 2415.99);

  await assert.rejects(post('/api/personal/budgets', { group: 'pay', monthly: 10 }), { status: 400 });
  await assert.rejects(post('/api/personal/budgets', { group: 'food', monthly: 'lots' }), { status: 400 });
  assert.deepEqual((await post('/api/personal/budgets', { group: 'food', monthly: null })).budgets, {});
  assert.equal((await get(`/api/personal?month=${ahead}`)).detail.spent, 2315.99);
});

test('accounts can be picked, and a bad month is refused', async () => {
  const data = await get(`/api/personal?month=${lastMonth}&accounts=${checkingId}`);
  assert.deepEqual(data.selectedAccounts, [checkingId]);
  assert.equal(data.detail.spent, 2365.99);
  assert.ok(!data.detail.groups.find((g) => g.key === 'shopping').amount);
  assert.equal((await call('/api/personal?month=2026-1')).status, 400);
  assert.equal((await fetch(`${base}/api/personal`, { headers: { 'x-requested-with': 'expense-hub' } })).status, 401);
});

test("a business's account never shows in My money, even with a payment marked personal", async () => {
  const csv = ['Date,Description,Amount', `${usDate(lastMonth, 4)},CHECK 1001,-171.68`, ''].join('\n');
  await post('/api/bank/import', { content: csv, fileName: 'biz.csv', newAccount: { name: 'Business checking', kind: 'checking', owner: 'business' } });
  const { transactions } = await get('/api/bank/transactions?preset=all&kind=all&q=CHECK%201001');
  await post('/api/bank/transactions/update', { ids: [transactions[0].id], status: 'personal' });
  const data = await get(`/api/personal?month=${lastMonth}`);
  assert.ok(!data.accounts.some((a) => a.name === 'Business checking'));
  assert.equal(data.detail.spent, 2465.99);
});

test('a whole year adds up its months, with the rest of it forecast', async () => {
  const year = thisMonth.slice(0, 4);
  const data = await get(`/api/personal?year=${year}`);
  assert.equal(data.period, 'year');
  assert.deepEqual(data.span, { from: `${year}-01`, to: `${year}-12` });
  assert.equal(data.current, true);
  assert.equal(data.detail.pace.unit, 'month');
  assert.equal(data.detail.pace.days, 12);
  // Each complete month this year brought in 5,500; this month nothing yet.
  const past = [1, 2, 3, 4, 5, 6].map((i) => addMonths(thisMonth, -i)).filter((m) => m.startsWith(year)).length;
  assert.equal(data.detail.earned, 5500 * past);
  assert.ok(data.detail.outlook.earned > data.detail.earned, 'the months ahead add expected pay');
  assert.equal(data.detail.groups.find((g) => g.key === 'home').typical, 24000);

  const before = await get(`/api/personal?year=${Number(year) - 1}`);
  assert.equal(before.current, false);
  assert.equal(before.detail.outlook, null);
  const ahead = await get(`/api/personal?year=${Number(year) + 1}`);
  assert.equal(ahead.future, true);
  assert.equal(ahead.detail.earned, 5500 * 12);
  assert.equal((await call('/api/personal?year=26')).status, 400);
});

test('family members have their own accounts and budgets, and a login that sees only theirs', async () => {
  const { accounts } = await get('/api/bank/accounts');
  const cardId = accounts.find((a) => a.name === 'Rewards card').id;
  const { id: kid, accounts: choices } = await post('/api/people', { name: 'Kid Example' });
  // A business's account can't be given to anyone.
  assert.ok(!choices.some((a) => a.name === 'Business checking'));
  await assert.rejects(post(`/api/people/${kid}`, { accounts: [accounts.find((a) => a.name === 'Business checking').id] }), { status: 400 });
  await post(`/api/people/${kid}`, { accounts: [cardId] });
  await assert.rejects(post('/api/people', { name: 'kid example' }), { status: 409 });

  // The card leaves the owner's money and becomes the kid's.
  const mine = await get(`/api/personal?month=${lastMonth}`);
  assert.ok(!mine.accounts.some((a) => a.id === cardId));
  assert.equal(mine.detail.spent, 2365.99);
  assert.deepEqual(mine.people, [{ id: kid, name: 'Kid Example' }]);
  const theirs = await get(`/api/personal?month=${lastMonth}&person=${kid}`);
  assert.deepEqual(theirs.person, { id: kid, name: 'Kid Example' });
  assert.deepEqual(
    theirs.accounts.map((a) => a.id),
    [cardId],
  );
  assert.equal(theirs.detail.spent, 100);
  assert.equal((await call('/api/personal?person=999')).status, 404);

  // Budgets are each person's own.
  await post('/api/personal/budgets', { group: 'shopping', monthly: 150, person: kid });
  assert.deepEqual((await get(`/api/personal?person=${kid}`)).budgets, { shopping: 150 });
  assert.deepEqual((await get('/api/personal')).budgets, {});

  // A login for them; usernames are unique, the owner's included.
  await post(`/api/people/${kid}/login`, { username: 'kid', password: 'kid test password' });
  await assert.rejects(post(`/api/people/${kid}/login`, { username: 'kid2', password: 'kid test password' }), { status: 409 });
  const other = await post('/api/people', { name: 'Other Example' });
  await assert.rejects(post(`/api/people/${other.id}/login`, { username: 'OWNER', password: 'kid test password' }), { status: 409 });
  const signIn = async (password) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
      body: JSON.stringify({ username: 'kid', password }),
    });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  };
  const session = await signIn('kid test password');
  assert.equal(session.response.status, 200);
  assert.deepEqual(session.body.user, { username: 'kid', totpEnabled: false, role: 'member', person: { id: kid, name: 'Kid Example' } });
  const asKid = (route, options = {}) =>
    fetch(`${base}${route}`, { ...options, headers: { cookie: session.cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });

  // Their own money only: asking for the owner's, or someone else's account, still gets theirs.
  for (const route of [`/api/personal?month=${lastMonth}`, `/api/personal?month=${lastMonth}&person=me`, `/api/personal?month=${lastMonth}&accounts=${checkingId}`]) {
    const data = await (await asKid(route)).json();
    assert.deepEqual(
      data.accounts.map((a) => a.id),
      [cardId],
      route,
    );
    assert.deepEqual(data.people, []);
    assert.equal(data.detail.spent, 100);
  }
  // Nothing else: not the books, the settings, other people, or budgets.
  for (const route of ['/api/bank/accounts', '/api/bank/transactions', '/api/settings/token', '/api/people', '/api/entities', '/api/status']) {
    assert.equal((await asKid(route)).status, 403, route);
  }
  assert.equal((await asKid('/api/personal/budgets', { method: 'POST', body: JSON.stringify({ group: 'food', monthly: 1 }) })).status, 403);
  assert.equal((await asKid(`/api/people/${kid}/delete`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await asKid('/api/auth/state')).status, 200);

  // A reset by the owner signs them out.
  await post(`/api/people/${kid}/login/password`, { password: 'a new kid password' });
  assert.equal((await asKid('/api/personal')).status, 401);
  assert.equal((await signIn('kid test password')).response.status, 401);
  assert.equal((await signIn('a new kid password')).response.status, 200);

  // Removing the person gives the card back and removes the login.
  const left = await post(`/api/people/${kid}/delete`);
  assert.ok(!left.people.some((p) => p.id === kid));
  assert.ok((await get('/api/personal')).accounts.some((a) => a.id === cardId));
  assert.equal((await signIn('a new kid password')).response.status, 401);
});

test('a shared account given to a family member becomes theirs, and counts in their budget', async () => {
  await post('/api/bank/import', {
    content: ['Date,Description,Amount', `${usDate(lastMonth, 9)},CORNER BOOKSHOP,-42.00`, ''].join('\n'),
    fileName: 'shared.csv',
    newAccount: { name: 'Shared card', kind: 'credit', owner: 'mixed' },
  });
  let { accounts } = await get('/api/bank/accounts');
  const shared = accounts.find((a) => a.name === 'Shared card');
  const { id: kid } = await post('/api/people', { name: 'Card Example' });
  assert.equal((await get(`/api/personal?month=${lastMonth}&person=${kid}`)).accounts.length, 0);

  await post(`/api/people/${kid}`, { accounts: [shared.id] });
  ({ accounts } = await get('/api/bank/accounts'));
  assert.equal(accounts.find((a) => a.id === shared.id).owner, 'personal');
  const theirs = await get(`/api/personal?month=${lastMonth}&person=${kid}`);
  assert.deepEqual(
    theirs.accounts.map((a) => a.id),
    [shared.id],
  );
  assert.equal(theirs.detail.spent, 42);
  await post(`/api/people/${kid}/delete`);
  await post(`/api/bank/accounts/${shared.id}`, { owner: 'mixed' });
});

test('money sent between family counts for both, and takes a category on both sides', async () => {
  // The owner's checking sends 500 to a second checking account, matched as a transfer.
  await post('/api/bank/import', {
    content: ['Date,Description,Amount', `${usDate(lastMonth, 6)},ONLINE TRANSFER TO CHK ...4242,-500.00`, ''].join('\n'),
    fileName: 'out.csv',
    accountId: checkingId,
  });
  await post('/api/bank/import', {
    content: ['Date,Description,Amount', `${usDate(lastMonth, 6)},ONLINE TRANSFER FROM CHK ...1111,500.00`, ''].join('\n'),
    fileName: 'sib.csv',
    newAccount: { name: 'Sib checking', kind: 'checking', owner: 'personal' },
  });
  const { transactions } = await get('/api/bank/transactions?preset=all&kind=all&q=ONLINE%20TRANSFER');
  assert.equal(transactions.length, 2);
  assert.ok(
    transactions.every((t) => t.kind === 'transfer' && t.transferId),
    'the two sides are paired as a transfer',
  );
  const sent = transactions.find((t) => t.amount < 0);

  // While both accounts are the owner's, it's money moved between their own accounts.
  let mine = await get(`/api/personal?month=${lastMonth}`);
  assert.equal(mine.detail.spent, 2465.99);
  assert.deepEqual(mine.family, []);

  // Once the second account is a family member's, it's money out for one and in for the other.
  const { accounts } = await get('/api/bank/accounts');
  const { id: sib } = await post('/api/people', { name: 'Sib Example' });
  await post(`/api/people/${sib}`, { accounts: [accounts.find((a) => a.name === 'Sib checking').id] });
  mine = await get(`/api/personal?month=${lastMonth}`);
  assert.equal(mine.detail.spent, 2965.99);
  assert.equal(mine.detail.groups.find((g) => g.key === 'family').amount, 500);
  assert.deepEqual(
    mine.family.map((r) => [r.name, r.amount, r.label]),
    [['To Sib Example', -500, null]],
  );
  let theirs = await get(`/api/personal?month=${lastMonth}&person=${sib}`);
  assert.equal(theirs.detail.earned, 500);
  assert.equal(theirs.detail.sources[0].key, 'family_in');
  assert.deepEqual(
    theirs.family.map((r) => r.name),
    ['From Everyday checking'],
  );

  // A category counts it as that kind of spending for the sender, and shows on both sides.
  const fees = mine.familyLabels.find((l) => l.name === 'University fees');
  assert.equal(fees.group, 'education');
  await post('/api/personal/family', { transactionId: sent.id, labelId: fees.id });
  mine = await get(`/api/personal?month=${lastMonth}`);
  assert.equal(mine.detail.groups.find((g) => g.key === 'education').amount, 500);
  assert.equal(mine.detail.groups.find((g) => g.key === 'family').amount, 0);
  assert.equal(mine.family[0].label, 'University fees');
  theirs = await get(`/api/personal?month=${lastMonth}&person=${sib}`);
  assert.equal(theirs.family[0].label, 'University fees');
  assert.equal(theirs.detail.earned, 500);

  // New categories of the owner's own.
  const { id: gift, labels } = await post('/api/personal/labels', { name: 'Birthday gift', group: 'shopping' });
  assert.ok(labels.some((l) => l.name === 'Birthday gift'));
  await post('/api/personal/family', { transactionId: sent.id, labelId: gift });
  assert.equal((await get(`/api/personal?month=${lastMonth}`)).detail.groups.find((g) => g.key === 'shopping').amount, 600);
  await assert.rejects(post('/api/personal/labels', { name: 'birthday GIFT', group: 'shopping' }), { status: 400 });
  await assert.rejects(post('/api/personal/labels', { name: 'Pay', group: 'pay' }), { status: 400 });
  // Only transfers take one.
  const normal = (await get('/api/bank/transactions?preset=all&q=NETFLIX&limit=1')).transactions[0];
  await assert.rejects(post('/api/personal/family', { transactionId: normal.id, labelId: gift }), { status: 400 });
  // And it can be taken off again.
  await post('/api/personal/family', { transactionId: sent.id, labelId: null });
  assert.equal((await get(`/api/personal?month=${lastMonth}`)).family[0].label, null);
});

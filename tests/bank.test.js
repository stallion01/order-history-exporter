// Bank and card accounts: file parsers, de-duplication across sources, transfers,
// rules, exports and SimpleFIN (against a fake bridge, never a real bank).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { parseOfx, writeOfx } = require('../server/dist/bank/ofx');
const { applyMapping, guessMapping, parseAmount, parseDate, readTable } = require('../server/dist/bank/csv');
const { payeeFor, categoryHint } = require('../server/dist/bank/merchant');
const { similarDescriptions } = require('../server/dist/bank/store');
const { claimToken, decodeToken } = require('../server/dist/bank/simplefin');
const { fileSecretBox } = require('../server/dist/secrets');

/* ---------- Sample files (made up) ---------- */

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260301</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>011000015<ACCTID>123456789012<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000.000[-5:EST]<TRNAMT>-42.17<FITID>F1<NAME>SHELL OIL 57444 BOSTON MA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260110<TRNAMT>-500.00<FITID>F2<NAME>ONLINE PAYMENT TO CARD 4321<MEMO>Thank you</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260115<TRNAMT>1,250.00<FITID>F3<NAME>AIRBNB PAYMENTS &amp; CO</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3210.55<DTASOF>20260131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>USD</CURDEF>
<CCACCTFROM><ACCTID>4111111111114321</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260108</DTPOSTED><TRNAMT>-19.99</TRNAMT><FITID>C1</FITID><NAME>ADOBE *CREATIVE CLOUD</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260111</DTPOSTED><TRNAMT>500.00</TRNAMT><FITID>C2</FITID><NAME>PAYMENT THANK YOU</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-19.99</BALAMT><DTASOF>20260131</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

// Many card exports list purchases as positive numbers, with lines above the headings.
const CARD_CSV = `Account: Rewards Card ending 4321
Statement period: Jan 2026

Transaction Date,Post Date,Description,Category,Type,Amount
01/07/2026,01/08/2026,"ADOBE *CREATIVE CLOUD",Software,Sale,19.99
01/09/2026,01/09/2026,"STARBUCKS #1234, SEATTLE",Food,Sale,5.25
01/09/2026,01/09/2026,"STARBUCKS #1234, SEATTLE",Food,Sale,5.25
01/11/2026,01/11/2026,PAYMENT THANK YOU,,Payment,-500.00
01/12/2026,01/12/2026,COSTCO WHSE #0123,Shopping,Sale,212.40
`;

const BANK_CSV = `Date;Description;Withdrawal;Deposit;Balance
2026-02-02;"POS PURCHASE HOME DEPOT #2345";84.10;;1000.00
2026-02-03;PAYROLL DEPOSIT;;2000.00;3000.00
`;

/* ---------- A server with a fake SimpleFIN bridge ---------- */

let dir;
let db;
let app;
let base;
let cookie;
const bridge = { claims: 0, requests: [], accounts: [] };
const CLAIM_URL = 'https://bridge.example/simplefin/claim/DEMO';
const ACCESS_URL = 'https://user:secret%21@bridge.example/simplefin';

async function fakeFetch(url, init = {}) {
  const href = String(url);
  if (href === CLAIM_URL && init.method === 'POST') {
    bridge.claims++;
    return new Response(bridge.claims === 1 ? ACCESS_URL : 'used', { status: bridge.claims === 1 ? 200 : 403 });
  }
  if (href.startsWith('https://bridge.example/simplefin/accounts?')) {
    bridge.requests.push({ url: href, auth: init.headers?.Authorization });
    return Response.json({ errlist: [], connections: [{ conn_id: 'c1', name: 'First Example Bank' }], accounts: bridge.accounts });
  }
  return new Response('not found', { status: 404 });
}

const call = (route, options = {}) =>
  fetch(`${base}${route}`, {
    ...options,
    headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) },
  });
const post = async (route, body) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-bank-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true, secrets: fileSecretBox(dir), fetchImpl: fakeFetch });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- Parsers ---------- */

test('OFX 1.x (SGML) and 2.x (XML) statements are read', () => {
  const [checking] = parseOfx(OFX_SGML);
  assert.equal(checking.kind, 'checking');
  assert.equal(checking.last4, '9012');
  assert.equal(checking.balance, 3210.55);
  assert.equal(checking.balanceDate, '2026-01-31');
  assert.deepEqual(
    checking.transactions.map((t) => [t.externalId, t.posted, t.amount]),
    [
      ['F1', '2026-01-05', -42.17],
      ['F2', '2026-01-10', -500],
      ['F3', '2026-01-15', 1250],
    ]
  );
  assert.equal(checking.transactions[2].description, 'AIRBNB PAYMENTS & CO', 'entities are decoded');
  assert.equal(checking.transactions[1].memo, 'Thank you');

  const [card] = parseOfx(OFX_XML);
  assert.equal(card.kind, 'credit');
  assert.equal(card.last4, '4321');
  assert.equal(card.transactions.length, 2);
  assert.throws(() => parseOfx('not a statement'), /OFX/);
});

test('CSV: headings found below a preamble, purchases flipped, two identical rows kept', () => {
  const table = readTable(CARD_CSV);
  assert.equal(table.headers[0], 'Transaction Date');
  const mapping = guessMapping(table);
  assert.equal(table.headers[mapping.date], 'Post Date', 'the posted date is preferred');
  assert.equal(table.headers[mapping.description], 'Description');
  assert.equal(table.headers[mapping.amount], 'Amount');
  assert.equal(mapping.flip, true, 'mostly positive amounts mean purchases are positive');
  const { transactions } = applyMapping(table, mapping);
  assert.equal(transactions.length, 5);
  assert.equal(transactions[0].amount, -19.99);
  assert.equal(transactions[3].amount, 500, 'the payment becomes money in');
  assert.equal(transactions[1].description, 'STARBUCKS #1234, SEATTLE', 'quoted commas survive');

  const bank = readTable(BANK_CSV);
  const bankMapping = guessMapping(bank);
  assert.equal(bankMapping.amount, null);
  assert.equal(bank.headers[bankMapping.debit], 'Withdrawal');
  assert.equal(bank.headers[bankMapping.credit], 'Deposit');
  assert.equal(bankMapping.dateOrder, 'ymd');
  assert.deepEqual(applyMapping(bank, bankMapping).transactions.map((t) => t.amount), [-84.1, 2000]);

  // "Paid out" and "Paid in" columns, day-first dates, a line above the headings.
  const savings = readTable(`Savings account export
Date,Details,Paid out,Paid in,Balance
02/11/2026,INTEREST PAID,,3.12,5003.12
31/10/2026,OPENING DEPOSIT,,5000.00,5000.00
05/11/2026,TRANSFER TO CHECKING,500.00,,4503.12
`);
  const savingsMapping = guessMapping(savings);
  assert.deepEqual([savings.headers[savingsMapping.description], savings.headers[savingsMapping.debit], savings.headers[savingsMapping.credit], savingsMapping.dateOrder], ['Details', 'Paid out', 'Paid in', 'dmy']);
  assert.deepEqual(applyMapping(savings, savingsMapping).transactions.map((t) => [t.posted, t.amount]), [['2026-11-02', 3.12], ['2026-10-31', 5000], ['2026-11-05', -500]]);
});

test('CSV: a rental account full of payouts is not mistaken for a card statement', () => {
  // Mostly positive, because most of it is income.
  const rental = readTable(`Date,Description,Amount
03/01/2026,AIRBNB 4977 PAYMENTS,812.40
03/04/2026,AIRBNB PAYMENTS,655.00
03/07/2026,HOMEAWAY.COM PAYOUT,1210.00
03/09/2026,BOOKING.COM BV PAYMENT,430.55
03/12/2026,POS PURCHASE HOME DEPOT,-84.10
03/15/2026,AIRBNB PAYMENTS,700.00
`);
  const mapping = guessMapping(rental);
  assert.equal(mapping.flip, false);
  const rows = applyMapping(rental, mapping).transactions;
  assert.deepEqual(rows.map((t) => t.amount), [812.4, 655, 1210, 430.55, -84.1, 700]);
  assert.deepEqual(rows.slice(0, 4).map((t) => [payeeFor(t.description), categoryHint(t.description, payeeFor(t.description), t.amount)]), [
    ['Airbnb', 'Rental Income'],
    ['Airbnb', 'Rental Income'],
    ['Vrbo', 'Rental Income'],
    ['Booking.com', 'Rental Income'],
  ]);

  // Every amount positive, with a column saying which way it went.
  const typed = readTable(`Posting Date,Description,Amount,Type
03/01/2026,AIRBNB PAYMENTS,812.40,Credit
03/02/2026,SHELL OIL 57444,42.17,Debit
03/03/2026,ACME HARDWARE,19.99,DR
03/04/2026,VRBO PAYOUT,300.00,CR
`);
  const typedMapping = guessMapping(typed);
  assert.equal(typed.headers[typedMapping.direction], 'Type');
  assert.deepEqual(applyMapping(typed, typedMapping).transactions.map((t) => t.amount), [812.4, -42.17, -19.99, 300]);
});

test('dates and amounts in the forms banks use', () => {
  assert.equal(parseDate('1/5/2026'), '2026-01-05');
  assert.equal(parseDate('01/05/26'), '2026-01-05');
  assert.equal(parseDate('05/01/2026', 'dmy'), '2026-01-05');
  assert.equal(parseDate('2026-01-05'), '2026-01-05');
  assert.equal(parseDate('20260105'), '2026-01-05');
  assert.equal(parseDate('5 Jan 2026'), '2026-01-05');
  assert.equal(parseDate('Jan 5, 2026'), '2026-01-05');
  assert.equal(parseDate('2/30/2026'), null, 'no such day');
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(12.34)'), -12.34);
  assert.equal(parseAmount('12.34-'), -12.34);
  assert.equal(parseAmount('12.34 DR'), -12.34);
  assert.equal(parseAmount('-$5'), -5);
  assert.equal(parseAmount('abc'), null);
});

test('payee names, category hints and matching descriptions', () => {
  assert.equal(payeeFor('AMZN Mktp US*2K4L71AB3'), 'Amazon');
  assert.equal(payeeFor('POS PURCHASE SHELL OIL 57444 BOSTON MA'), 'Shell Oil');
  assert.equal(payeeFor('SQ *BLUE BOTTLE COFFEE'), 'Blue Bottle Coffee');
  assert.equal(categoryHint('SHELL OIL 57444', 'Shell Oil', -40), 'Automotive & Fuel');
  assert.equal(categoryHint('AMZN Mktp US', 'Amazon', -40), null, 'store charges wait for their orders');
  assert.equal(categoryHint('AMAZON REFUND', 'Amazon', 40), 'Refunds & Returns');
  assert.ok(similarDescriptions('SHELL OIL 57444 BOSTON MA', 'Shell Oil'));
  assert.ok(similarDescriptions('ADOBE *CREATIVE CLOUD', 'ADOBE CREATIVE CLD 800-833-6687'));
  assert.ok(!similarDescriptions('STARBUCKS #1234', 'DUNKIN #55'));
});

/* ---------- Through the API ---------- */

test('bank pages need a signed-in user', async () => {
  const response = await fetch(`${base}/api/bank/accounts`);
  assert.equal(response.status, 401);
  const withToken = await fetch(`${base}/api/bank/accounts`, { headers: { Authorization: 'Bearer tok' } });
  assert.equal(withToken.status, 403, 'the extension token only syncs orders');
});

let checkingId;
let cardId;

test('importing: preview first, then import; the same file again adds nothing', async () => {
  const inspect = await post('/api/bank/import/inspect', { fileName: 'checking.qfx', content: OFX_SGML });
  assert.equal(inspect.type, 'ofx');
  assert.equal(inspect.statements[0].count, 3);
  assert.equal(inspect.statements[0].accountId, null);

  const newAccount = { name: 'Business Checking', kind: 'checking', owner: 'business' };
  const preview = await post('/api/bank/import', { fileName: 'checking.qfx', content: OFX_SGML, newAccount, dryRun: true });
  assert.equal(preview.added, 3);
  assert.equal(preview.accountId, null);
  assert.equal((await get('/api/bank/accounts')).accounts.length, 0, 'a preview saves nothing');

  const real = await post('/api/bank/import', { fileName: 'checking.qfx', content: OFX_SGML, newAccount });
  assert.equal(real.added, 3);
  checkingId = real.accountId;
  const again = await post('/api/bank/import', { fileName: 'checking.qfx', content: OFX_SGML, accountId: checkingId });
  assert.deepEqual([again.added, again.skipped], [0, 3]);
  // The account is recognised next time, from a hash of its number.
  assert.equal((await post('/api/bank/import/inspect', { content: OFX_SGML })).statements[0].accountId, checkingId);
  const raw = JSON.stringify(db.raw.prepare('SELECT * FROM bank_accounts').all());
  assert.ok(!raw.includes('123456789012'), 'the full account number is never stored');
});

test('a card statement as QFX, then the same months as CSV: overlapping rows merge', async () => {
  const card = await post('/api/bank/import', { fileName: 'card.qfx', content: OFX_XML, newAccount: { name: 'Rewards Card', kind: 'credit', owner: 'mixed' } });
  cardId = card.accountId;
  assert.equal(card.added, 2);

  const inspect = await post('/api/bank/import/inspect', { content: CARD_CSV });
  const result = await post('/api/bank/import', { fileName: 'card.csv', content: CARD_CSV, accountId: cardId, mapping: inspect.mapping });
  // Adobe and the payment were already there from the QFX; both coffees and Costco are new.
  assert.deepEqual([result.added, result.merged, result.skipped], [3, 2, 0]);
  const again = await post('/api/bank/import', { content: CARD_CSV, accountId: cardId, mapping: inspect.mapping });
  assert.deepEqual([again.added, again.skipped], [0, 5]);

  // An import's result lists only the transactions in that file, not the rest of the account.
  const fromFile = async (id, extra = '') => (await get(`/api/bank/transactions?import=${id}&kind=all${extra}`)).transactions;
  assert.equal((await get(`/api/bank/transactions?account=${cardId}&kind=all`)).total, 5);
  const first = await fromFile(result.importId);
  assert.equal(first.length, 5);
  assert.deepEqual((await fromFile(result.importId, '&outcome=merged')).map((t) => t.payee).sort(), ['Adobe Creative Cloud', 'Card payment']);
  assert.equal((await fromFile(result.importId, '&outcome=added')).length, 3);
  assert.equal((await fromFile(again.importId, '&outcome=skipped')).length, 5);
  assert.equal((await fromFile(card.importId)).length, 2, 'the QFX had only two');
  assert.equal((await get(`/api/bank/imports/${result.importId}`)).fileName, 'card.csv');
  assert.equal((await call('/api/bank/transactions?outcome=bogus')).status, 400);
  const dry = await post('/api/bank/import', { content: CARD_CSV, accountId: cardId, mapping: inspect.mapping, dryRun: true });
  assert.equal(dry.importId, null, 'a preview leaves no history');
  // The layout and account are remembered for this bank's next file.
  const remembered = await post('/api/bank/import/inspect', { content: CARD_CSV });
  assert.equal(remembered.remembered, true);
  assert.equal(remembered.accountId, cardId);

  const adobe = (await get(`/api/bank/transactions?account=${cardId}&q=adobe`)).transactions[0];
  assert.deepEqual(adobe.sources.sort(), ['csv', 'ofx']);
  assert.equal(adobe.category, 'Software & Subscriptions');
  assert.equal(adobe.categorySource, 'payee');
});

test('paying the card from checking is a transfer, not spending', async () => {
  const transfers = await get('/api/bank/transactions?kind=transfer');
  assert.equal(transfers.total, 2);
  const out = transfers.transactions.find((t) => t.amount === -500);
  assert.equal(out.transferAccount, 'Rewards Card');
  const spending = await get(`/api/bank/transactions?account=${checkingId}`);
  assert.equal(spending.moneyOut, 42.17, 'only the fuel counts as money out');
  // Business account: its spending is business unless decided otherwise.
  assert.equal(spending.transactions.find((t) => t.amount === -42.17).status, 'business');
});

test('edits and rules: the user wins, a rule applies to later rows too', async () => {
  const costco = (await get(`/api/bank/transactions?account=${cardId}&q=costco`)).transactions[0];
  assert.equal(costco.status, null, 'a mixed account leaves it to the user');
  assert.ok((await get('/api/bank/transactions?review=1')).total >= 1);

  await post('/api/bank/transactions/update', { ids: [costco.id], category: 'Cleaning Supplies', status: 'business', rule: { pattern: 'COSTCO' } });
  const after = (await get(`/api/bank/transactions?account=${cardId}&q=costco`)).transactions[0];
  assert.deepEqual([after.category, after.categorySource, after.status, after.statusSource], ['Cleaning Supplies', 'user', 'business', 'user']);
  assert.equal((await get('/api/bank/rules')).rules[0].pattern, 'COSTCO');

  // A later Costco charge gets the rule's choices.
  const csv = 'Date,Description,Amount\n02/01/2026,COSTCO WHSE #0999,-99.00\n02/02/2026,COSTCO GAS #0999,-45.00\n02/03/2026,LOCAL DINER,-20.00\n';
  await post('/api/bank/import', { content: csv, accountId: cardId });
  const later = (await get(`/api/bank/transactions?account=${cardId}&q=costco&from=2026-02-01`)).transactions;
  assert.equal(later.length, 2);
  assert.ok(later.every((t) => t.category === 'Cleaning Supplies' && t.categorySource === 'rule' && t.status === 'business'));

  // Marking something ignored takes it out of spending; null puts it back.
  const diner = (await get(`/api/bank/transactions?q=diner`)).transactions[0];
  assert.equal(diner.category, 'Meals');
  await post('/api/bank/transactions/update', { ids: [diner.id], kind: 'ignored' });
  assert.equal((await get(`/api/bank/transactions?q=diner`)).total, 0);
  assert.equal((await get(`/api/bank/transactions?q=diner&kind=ignored`)).total, 1);
  await post('/api/bank/transactions/update', { ids: [diner.id], kind: null });
  assert.equal((await get(`/api/bank/transactions?q=diner`)).total, 1);

  await assert.rejects(post('/api/bank/transactions/update', { ids: [diner.id], category: 'Not a category' }), /Unknown category/);
});

test('transactions imported the wrong way round can be swapped back, and stay fixed', async () => {
  const csv = `Date,Description,Amount
04/01/2026,AIRBNB 4977 PAYMENTS,812.40
04/03/2026,BOOKING.COM BV PAYMENT,430.55
04/05/2026,ACE HARDWARE 0099,-25.00
`;
  const wrong = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: true, dateOrder: 'mdy' };
  const { accountId } = await post('/api/bank/import', { content: csv, fileName: 'rental.csv', mapping: wrong, newAccount: { name: 'Rental Checking', kind: 'checking', owner: 'business' } });
  const list = async () => (await get(`/api/bank/transactions?account=${accountId}&kind=all&preset=all`)).transactions;
  const airbnb = (await list()).find((t) => t.payee === 'Airbnb');
  assert.equal(airbnb.amount, -812.4);
  assert.equal(airbnb.category, 'Platform & Merchant Fees', 'as spending, it looked like a fee');

  const payouts = (await list()).filter((t) => t.payee !== 'Ace Hardware');
  await post('/api/bank/transactions/update', { ids: payouts.map((t) => t.id), flipSign: true });
  const fixed = await list();
  assert.deepEqual(
    fixed.filter((t) => t.payee !== 'Ace Hardware').map((t) => [t.payee, t.amount, t.category]).sort(),
    [
      ['Airbnb', 812.4, 'Rental Income'],
      ['Booking.com', 430.55, 'Rental Income'],
    ]
  );
  // The same file imported again, now read the right way round, adds no duplicates.
  const inspect = await post('/api/bank/import/inspect', { content: csv });
  assert.equal(inspect.mapping.flip, false);
  const again = await post('/api/bank/import', { content: csv, accountId, mapping: inspect.mapping });
  assert.equal(again.added, 1, 'only the hardware row, which was still the wrong way round');
  await assert.rejects(post('/api/bank/transactions/update', { ids: [airbnb.id], flipSign: false }));
});

test('card charges that came in as income are found and put right, and a new file is checked as it comes in', async () => {
  const cardCsv = (rows) => `Date,Description,Amount\n${rows.map(([d, n, a]) => `${d},${n},${a}`).join('\n')}\n`;
  const qfx = (rows) => `OFXHEADER:100\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>5555444433332222</CCACCTFROM><BANKTRANLIST>
${rows.map(([d, a, n], i) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d}<TRNAMT>${a}<FITID>W${d}${i}<NAME>${n}</STMTTRN>`).join('\n')}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  // A card CSV read with charges as money in (as an older version could).
  const asIncome = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: false, dateOrder: 'mdy' };
  const firstCsv = cardCsv([
    ['01/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['02/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['03/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['04/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['03/10/2026', 'DUKE ENERGY', '80.12'],
  ]);
  const { accountId } = await post('/api/bank/import', { content: firstCsv, fileName: 'card.csv', mapping: asIncome, newAccount: { name: 'Business Card', kind: 'credit', owner: 'business' } });
  // Then the card's own QFX for February to April, with charges as money out.
  await post('/api/bank/import', {
    content: qfx([
      ['20260206', '-100.00', 'TRASHCO SPRINGFIELD'],
      ['20260305', '-100.00', 'TRASHCO SPRINGFIELD'],
      ['20260406', '-100.00', 'TRASHCO SPRINGFIELD'],
    ]),
    fileName: 'card.qfx',
    accountId,
  });
  const list = async () => (await get(`/api/bank/transactions?account=${accountId}&kind=all&preset=all`)).transactions;
  assert.equal((await list()).filter((t) => /TRASHCO/.test(t.description)).length, 7, 'each charge twice, once each way');

  const { problems } = await get('/api/bank/sign-problems');
  const mine = problems.filter((p) => p.accountId === accountId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].from, /card\.csv/);
  assert.deepEqual([mine[0].count, mine[0].duplicates], [5, 3]);

  assert.deepEqual(await post('/api/bank/sign-problems/fix', { keys: [mine[0].key] }), { flipped: 2, merged: 3 });
  const fixed = await list();
  assert.deepEqual(fixed.map((t) => t.amount).sort((a, b) => a - b), [-100, -100, -100, -100, -80.12]);
  assert.equal((await get('/api/bank/sign-problems')).problems.filter((p) => p.accountId === accountId).length, 0);
  // The CSV again, read the right way round: nothing new.
  const inspect = await post('/api/bank/import/inspect', { content: firstCsv });
  assert.equal(inspect.mapping.flip, true);
  const again = await post('/api/bank/import', { content: firstCsv, accountId, mapping: inspect.mapping });
  assert.deepEqual([again.added, again.skipped], [0, 5]);

  // A new file the wrong way round is put right as it comes in, preview included.
  const later = cardCsv([
    ['03/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['04/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
    ['05/05/2026', 'TRASHCO SPRINGFIELD IL', '100.00'],
  ]);
  const preview = await post('/api/bank/import', { content: later, accountId, mapping: asIncome, dryRun: true });
  assert.deepEqual([preview.signsFixed, preview.added, preview.skipped + preview.merged], [3, 1, 2]);
  const result = await post('/api/bank/import', { content: later, accountId, mapping: asIncome, fileName: 'may.csv' });
  assert.equal(result.signsFixed, 3);
  const may = (await list()).filter((t) => t.posted === '2026-05-05');
  assert.deepEqual(may.map((t) => t.amount), [-100]);
  assert.equal((await list()).length, 6);
});

test('a checking CSV imported backwards, with its payouts already swapped back by hand, is put right', async () => {
  // As it happened: the bank's own feed, right way round...
  const feed = (rows) => `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>99990001234<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>
${rows.map(([d, a, n], i) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d}<TRNAMT>${a}<FITID>R${i}<NAME>${n}</STMTTRN>`).join('\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const { accountId } = await post('/api/bank/import', {
    content: feed([
      ['20260904', '-100.00', 'TRASH CO SPRNGFLD DES:XXXXX11111 ID:XXXXX0003'],
      ['20261006', '-100.00', 'TRASH CO SPRNGFLD DES:XXXXX11111 ID:XXXXX0004'],
      ['20260924', '-95.00', 'POWERCO DES:BILL PAY ID:XXXXX0000001'],
      ['20260921', '-170.00', 'Zelle payment to Lawn Helper for lawn'],
      ['20260924', '-110.00', 'THE CITY OF SPRI DES:BILLPAY ID:CITY OF SPRINGF'],
      ['20260915', '210.00', 'AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT001'],
      ['20261013', '230.00', 'AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT002'],
    ]),
    fileName: 'feed.qfx',
    newAccount: { name: 'Rental Checking', kind: 'other', owner: 'business' },
  });
  // ...then the CSV, imported backwards by an older version (stored here as it ended up)...
  const backwards = [
    ['2026-06-03', 100, 'TRASH CO SPRNGFLD DES:5550011111 ID:100000001'],
    ['2026-07-06', 100, 'TRASH CO SPRNGFLD DES:5550011111 ID:100000002'],
    ['2026-09-04', 100, 'TRASH CO SPRNGFLD DES:5550011111 ID:100000003'],
    ['2026-10-06', 100, 'TRASH CO SPRNGFLD DES:5550011111 ID:100000004'],
    ['2026-07-27', 105, 'POWERCO DES:BILL PAY ID:900000000001'],
    ['2026-09-24', 95, 'POWERCO DES:BILL PAY ID:900000000001'],
    ['2026-09-21', 170, 'Zelle payment to Lawn Helper for lawn'],
    ['2026-09-24', 110, 'THE CITY OF SPRI DES:BILLPAY ID:CITY OF SPRINGF'],
    ['2026-08-03', -450, 'Booking.com DES:ST-TEST001 ID:ST-TEST0001AAAA'],
    // ...with its Airbnb payouts since swapped back by hand.
    ['2026-07-21', 190, 'AIRBNB 1234 DES:AIRBNB ID:G-TESTPAYOUT003'],
    ['2026-09-15', 210, 'AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT001'],
    ['2026-10-13', 230, 'AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT002'],
  ];
  const add = db.raw.prepare(`INSERT INTO bank_transactions (account_id, posted, amount, description, payee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '')`);
  const source = db.raw.prepare(`INSERT INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, 'csv', ?, ?)`);
  backwards.forEach(([posted, amount, description], i) => source.run(accountId, `h:legacy${i}`, Number(add.run(accountId, posted, amount, description, description).lastInsertRowid)));

  const { problems } = await get('/api/bank/sign-problems');
  const mine = problems.filter((p) => p.accountId === accountId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].from, 'CSV rows');
  assert.equal(mine[0].count, 11, 'everything but the payout already put right and outside the feed');
  assert.equal(mine[0].duplicates, 7);
  assert.deepEqual(await post('/api/bank/sign-problems/fix', { keys: [mine[0].key] }), { flipped: 4, merged: 7 });

  const after = (await get(`/api/bank/transactions?account=${accountId}&kind=all&preset=all`)).transactions;
  const by = (word) => after.filter((t) => t.description.includes(word)).map((t) => t.amount).sort((a, b) => a - b);
  assert.deepEqual(by('TRASH CO'), [-100, -100, -100, -100]);
  assert.deepEqual(by('POWERCO'), [-105, -95]);
  assert.deepEqual(by('AIRBNB'), [190, 210, 230], 'each payout once');
  assert.deepEqual(by('Booking.com'), [450]);
  assert.equal(after.length, 12);
});

test('a savings CSV whose wording shows it came in backwards is put right on its own', async () => {
  const csv = `Date,Description,Amount
06/30/2026,Interest Earned,-0.96
07/22/2026,Online Banking transfer to CHK 1234 Confirmation# 1000000001,20000.00
06/08/2026,Online Banking transfer from CHK 5678 Confirmation# 1000000002,-10000.00
07/31/2026,Interest Earned,-0.81
`;
  const wrong = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: false, dateOrder: 'mdy' };
  const result = await post('/api/bank/import', { content: csv, fileName: 'sav.csv', mapping: wrong, newAccount: { name: 'Savings', kind: 'savings', owner: 'business' } });
  assert.equal(result.signsFixed, 4, 'turned round as it came in');
  const rows = (await get(`/api/bank/transactions?account=${result.accountId}&kind=all&preset=all`)).transactions;
  assert.deepEqual(rows.map((t) => t.amount).sort((a, b) => a - b), [-20000, 0.81, 0.96, 10000]);
});

test('money back from a store is a refund that reduces its spending, not income', async () => {
  const csv = `Date,Description,Amount
03/02/2026,ACME TOOLS 12,-50.00
03/09/2026,ACME TOOLS 12,-80.00
03/10/2026,ACME TOOLS 12,20.00
03/11/2026,GIZMO SUPPLY 7,-40.00
03/12/2026,GIZMO SUPPLY 7,15.00
03/15/2026,CONSULTING CLIENT LLC,500.00
`;
  const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: false, dateOrder: 'mdy' };
  const { accountId } = await post('/api/bank/import', { content: csv, fileName: 'refunds.csv', mapping, newAccount: { name: 'Shop Card', kind: 'credit', owner: 'business' } });
  const rows = async () => (await get(`/api/bank/transactions?account=${accountId}&kind=all&preset=all`)).transactions;
  const acme = (await rows()).filter((t) => t.description.startsWith('ACME'));
  await post('/api/bank/transactions/update', { ids: acme.filter((t) => t.amount < 0).map((t) => t.id), category: 'Tools & Hardware' });

  const after = await rows();
  const refund = after.find((t) => t.description.startsWith('ACME') && t.amount > 0);
  assert.deepEqual([refund.category, refund.categorySource], ['Tools & Hardware', 'payee'], "takes the category of what's bought there");
  const gizmo = after.find((t) => t.description.startsWith('GIZMO') && t.amount > 0);
  assert.equal(gizmo.category, 'Refunds & Returns', 'a store with no category yet');
  const client = after.find((t) => t.description.startsWith('CONSULTING'));
  assert.equal(client.category, null, 'money from someone never paid is still income');

  const income = await get(`/api/bank/transactions?account=${accountId}&direction=in&preset=all`);
  assert.deepEqual(income.transactions.map((t) => t.amount), [500]);
  const spending = await get(`/api/bank/transactions?account=${accountId}&direction=out&preset=all`);
  assert.equal(spending.total, 5, 'purchases and the refunds against them');
  const byCategory = Object.fromEntries((await get(`/api/bank/spending?account=${accountId}&preset=all`)).byCategory.map((c) => [c.label, c.spend]));
  assert.equal(byCategory['Tools & Hardware'], 110, '130 spent, 20 back');
});

test('paying a card from checking is a transfer even when the card never shows the payment', async () => {
  const csv = `Date,Description,Amount
02/09/2026,Online Banking payment to CRD 4455 Confirmation# 1000000003,-900.00
03/02/2026,Online Scheduled Payment to ACCT# 4455 Confirmation# 1000000004,-450.00
03/05/2026,Online Scheduled Payment to ACCT# 7788 Confirmation# 1000000005,-300.00
03/06/2026,CHASE CREDIT CRD AUTOPAY PPD ID: 0000000001,-120.00
03/07/2026,LAWN HELPER,-60.00
`;
  const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: false, dateOrder: 'mdy' };
  const { accountId } = await post('/api/bank/import', { content: csv, fileName: 'chk.csv', mapping, newAccount: { name: 'Paying Checking', kind: 'checking', owner: 'business' } });
  const rows = (await get(`/api/bank/transactions?account=${accountId}&kind=all&preset=all`)).transactions;
  const kinds = Object.fromEntries(rows.map((t) => [t.amount, t.kind]));
  assert.equal(kinds[-900], 'transfer', 'payment to a card');
  assert.equal(kinds[-450], 'transfer', 'payment to the same number, written as an account');
  assert.equal(kinds[-300], 'normal', 'an account number never seen as a card');
  assert.equal(kinds[-120], 'transfer', "a card issuer's autopay");
  assert.equal(kinds[-60], 'normal');
  const spending = await get(`/api/bank/transactions?account=${accountId}&direction=out&preset=all`);
  assert.deepEqual(spending.transactions.map((t) => t.amount).sort((a, b) => a - b), [-300, -60]);
});

test('spending and income by month, with income split by platform', async () => {
  const csv = `Date,Description,Amount
04/02/2026,AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT010,500.00
04/03/2026,Homeaway.com DES:Hom ID:TESTPAYOUT011,300.00
04/04/2026,Booking.com DES:ST-TEST012 ID:ST-TEST0012AAAA,200.00
04/05/2026,MOBILE DEPOSIT,50.00
04/06/2026,TRASHCO SPRINGFIELD,-100.00
05/02/2026,AIRBNB 1234 DES:AIRBNB ID:M-TESTPAYOUT013,250.00
05/09/2026,POWERCO DES:BILL PAY ID:900000000009,-1000.00
`;
  const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, memo: null, reference: null, flip: false, dateOrder: 'mdy' };
  const { accountId } = await post('/api/bank/import', { content: csv, fileName: 'months.csv', mapping, newAccount: { name: 'Months Checking', kind: 'checking', owner: 'business' } });
  const { byMonth } = await get(`/api/bank/spending?account=${accountId}&preset=all`);
  assert.deepEqual(byMonth, [
    { month: '2026-04', spend: 100, income: 1050, sources: { airbnb: 500, vrbo: 300, booking: 200, other: 50 } },
    { month: '2026-05', spend: 1000, income: 250, sources: { airbnb: 250, vrbo: 0, booking: 0, other: 0 } },
  ]);
});

test('exports: CSV with every column, and an OFX that imports back as nothing new', async () => {
  const csv = await (await call(`/api/bank/export.csv?account=${cardId}`)).text();
  assert.match(csv.split('\r\n')[0], /Date,Account,Payee,Description,Memo,Amount/);
  const ofxResponse = await call(`/api/bank/export.ofx?account=${cardId}&kind=all`);
  assert.match(ofxResponse.headers.get('content-disposition'), /rewards-card\.ofx/);
  const ofx = await ofxResponse.text();
  const [statement] = parseOfx(ofx);
  assert.equal(statement.kind, 'credit');
  const count = (await get(`/api/bank/transactions?account=${cardId}&kind=all`)).total;
  assert.equal(statement.transactions.length, count);
  const back = await post('/api/bank/import', { content: ofx, accountId: cardId });
  assert.deepEqual([back.added, back.skipped], [0, count], 'its own export is recognised');
});

test('writeOfx escapes text and keeps names to 32 characters', () => {
  const text = writeOfx({ id: 1, name: 'A', kind: 'checking', currency: 'USD', balance: null, balanceDate: null }, [{ id: 9, posted: '2026-01-02', amount: -3, description: 'A & B <long name that goes past thirty two characters>', memo: null }], '2026-01-03');
  const [s] = parseOfx(text);
  assert.equal(s.transactions[0].description, 'A & B <long name that goes past', 'cut at 32, then trimmed');
  assert.equal(s.transactions[0].memo, 'A & B <long name that goes past thirty two characters>');
});

/* ---------- SimpleFIN ---------- */

test('secrets are encrypted with a key kept outside the database', () => {
  const box = fileSecretBox(dir);
  const sealed = box.seal('https://user:pw@example');
  assert.ok(!sealed.includes('user'));
  assert.equal(box.open(sealed), 'https://user:pw@example');
  assert.throws(() => box.open(`${sealed.slice(0, -4)}AAAA`));
});

test('SimpleFIN tokens are decoded and claimed once', async () => {
  const token = Buffer.from(CLAIM_URL).toString('base64');
  assert.equal(decodeToken(token), CLAIM_URL);
  assert.throws(() => decodeToken(Buffer.from('http://insecure.example').toString('base64')), /SimpleFIN Token/);
  const counting = { claims: 0 };
  const once = async (url) => new Response(counting.claims++ ? 'x' : ACCESS_URL, { status: counting.claims > 1 ? 403 : 200 });
  assert.equal(await claimToken(token, once), ACCESS_URL);
  await assert.rejects(claimToken(token, once), /already used/);
});

test('SimpleFIN: connect, sync accounts, and merge with an overlapping file', async () => {
  const posted = (date) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
  bridge.accounts = [
    {
      id: 'sf-chk',
      name: 'Business Checking',
      conn_id: 'c1',
      currency: 'USD',
      balance: '3100.00',
      'balance-date': posted('2026-02-01'),
      transactions: [
        // Already imported from the QFX file: same amount, a day apart, different wording.
        { id: 't1', posted: posted('2026-01-06'), amount: '-42.17', description: 'SHELL OIL 57444' },
        { id: 't2', posted: posted('2026-01-20'), amount: '-61.00', description: 'NATIONAL GRID ELECTRIC' },
        { id: 't3', posted: 0, amount: '-9.00', description: 'PENDING CHARGE', pending: true },
      ],
    },
    { id: 'sf-sav', name: 'Savings', conn_id: 'c1', currency: 'USD', balance: '10.00', 'balance-date': posted('2026-02-01'), transactions: [] },
  ];
  const token = Buffer.from(CLAIM_URL).toString('base64');
  const { result, status } = await post('/api/bank/simplefin/connect', { token });
  assert.equal(status.connected, true);
  assert.deepEqual([result.accounts, result.newAccounts, result.added, result.merged], [2, 2, 2, 0]);
  const request = bridge.requests[0];
  assert.ok(!request.url.includes('secret'), 'credentials go in a header, not the address');
  assert.equal(request.auth, `Basic ${Buffer.from('user:secret!').toString('base64')}`);
  assert.match(request.url, /version=2&start-date=\d+&end-date=\d+/);

  const stored = db.raw.prepare("SELECT value FROM app_settings WHERE key = 'simplefin.access'").get().value;
  assert.ok(!stored.includes('secret') && stored.startsWith('v1:'), 'the access URL is stored encrypted');

  // SimpleFIN's accounts are separate from the file's until linked, so the fuel charge
  // is new there. Importing the QFX into the SimpleFIN account merges instead.
  const sfChecking = (await get('/api/bank/accounts')).accounts.find((a) => a.name === 'Business Checking' && a.sources.includes('simplefin'));
  assert.equal(sfChecking.institution, 'First Example Bank');
  assert.equal(sfChecking.balance, 3100);
  const merged = await post('/api/bank/import', { content: OFX_SGML, accountId: sfChecking.id });
  assert.deepEqual([merged.added, merged.merged], [2, 1], 'the fuel charge merges; the other two are new');

  // A second sync soon after is refused, to stay inside the bridge's daily quota.
  await assert.rejects(post('/api/bank/simplefin/sync', {}), /a few minutes ago/);
  await post('/api/bank/simplefin/disconnect', {});
  assert.equal((await get('/api/bank/accounts')).simplefin.connected, false);
});

// Stays from Hospitable (with a stand-in for its API): sync, matching payouts and
// stays to bank deposits, what's offered when it isn't clear, and the connection.
// All names, amounts and IDs here are made up.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { fileSecretBox } = require('../server/dist/secrets');

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
let dir;
let db;
let app;
let base;
let cookie;
const calls = [];

const money = (dollars) => ({ amount: Math.round(dollars * 100), formatted: `$${dollars}`, label: '', category: '' });
const reservation = (id, { platform, property, arrival, departure, guest, payout, status = 'accepted', booked = '2026-01-15', phone = '+1 555 0100' }) => ({
  id,
  code: `CODE-${id}`,
  platform,
  booking_date: `${booked}T10:00:00Z`,
  arrival_date: `${arrival}T16:00:00-05:00`,
  departure_date: `${departure}T11:00:00-05:00`,
  check_in: `${arrival}T16:00:00-05:00`,
  check_out: `${departure}T11:00:00-05:00`,
  nights: Math.round((Date.parse(departure) - Date.parse(arrival)) / 86400000),
  status,
  guests: { adult_count: 2, child_count: 1, infant_count: 0, pet_count: 0 },
  guest: { first_name: guest.split(' ')[0], last_name: guest.split(' ')[1], email: null, phone_numbers: [phone], location: 'Testville' },
  properties: [{ id: property }],
  financials: {
    currency: 'USD',
    guest: { accommodation: money(payout), fees: [{ ...money(80), label: 'Cleaning fee', category: 'Guest fees' }], taxes: [], discounts: [], total_price: money(payout + 140) },
    host: { accommodation: money(payout), guest_fees: [], host_fees: [{ ...money(-20), label: 'Host service fee', category: 'Service fees' }], discounts: [], adjustments: [], taxes: [], revenue: money(payout) },
  },
});

const PROPERTIES = [
  { id: 'prop-lake', name: 'Lake Cabin', public_name: 'Cozy Lake Cabin', address: { city: 'Testville', state: 'NC' } },
  { id: 'prop-hill', name: 'Hill House', public_name: 'Hill House', address: { city: 'Testville', state: 'NC' } },
  { id: 'prop-bay', name: 'Bay Studio', public_name: 'Bay Studio', address: { city: 'Testville', state: 'NC' } },
];
const RESERVATIONS = [
  reservation('res-a', { platform: 'airbnb', property: 'prop-lake', arrival: '2026-03-02', departure: '2026-03-05', guest: 'Pat Example', payout: 412.5 }),
  reservation('res-b', { platform: 'airbnb', property: 'prop-hill', arrival: '2026-03-03', departure: '2026-03-06', guest: 'Sam Sample', payout: 300 }),
  reservation('res-c', { platform: 'vrbo', property: 'prop-lake', arrival: '2026-04-10', departure: '2026-04-14', guest: 'Lee Tester', payout: 880, booked: '2026-02-01' }),
  reservation('res-d', { platform: 'homeaway', property: 'prop-hill', arrival: '2026-05-01', departure: '2026-05-03', guest: 'Kim Demo', payout: 500, booked: '2026-04-01' }),
  reservation('res-e', { platform: 'vrbo', property: 'prop-lake', arrival: '2026-05-03', departure: '2026-05-05', guest: 'Ash Trial', payout: 500, booked: '2026-04-02' }),
  reservation('res-f', { platform: 'airbnb', property: 'prop-lake', arrival: '2026-05-20', departure: '2026-05-22', guest: 'Jo Cancel', payout: 0, status: 'cancelled' }),
  reservation('res-g', { platform: 'booking', property: 'prop-hill', arrival: '2026-06-01', departure: '2026-06-04', guest: 'Max Booker', payout: 640, booked: '2026-05-10' }),
  reservation('res-h', { platform: 'airbnb', property: 'prop-hill', arrival: '2027-02-01', departure: '2027-02-03', guest: 'Future Guest', payout: 250, booked: '2026-03-01' }),
  // A third property for the combined deposits, conflicts and older stays.
  reservation('res-i', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-07-04', departure: '2026-07-06', guest: 'Ivy Combo', payout: 250 }),
  reservation('res-j', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-07-05', departure: '2026-07-06', guest: 'Jay Combo', payout: 180 }),
  reservation('res-k', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-08-01', departure: '2026-08-02', guest: 'Kit Clash', payout: 100 }),
  reservation('res-l', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-08-01', departure: '2026-08-02', guest: 'Lou Clash', payout: 60 }),
  reservation('res-m', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-08-02', departure: '2026-08-03', guest: 'Mo Clash', payout: 40 }),
  reservation('res-n', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-08-02', departure: '2026-08-03', guest: 'Nat Clash', payout: 160 }),
  // Before Hospitable's payout history: two stays paid in one deposit, and one before the bank records.
  reservation('res-o', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-01-10', departure: '2026-01-12', guest: 'Oak Early', payout: 220, booked: '2025-12-01' }),
  reservation('res-p', { platform: 'airbnb', property: 'prop-bay', arrival: '2026-01-11', departure: '2026-01-12', guest: 'Pine Early', payout: 330, booked: '2025-12-01' }),
  // Direct bookings: two units the same days paid by one check with a security deposit, and one part-paid.
  reservation('res-r', { platform: 'manual', property: 'prop-bay', arrival: '2026-09-10', departure: '2026-09-13', guest: 'Robin Pair', payout: 625, booked: '2026-08-20' }),
  reservation('res-s', { platform: 'manual', property: 'prop-lake', arrival: '2026-09-10', departure: '2026-09-13', guest: 'Robin Pair', payout: 625, booked: '2026-08-20' }),
  reservation('res-t', { platform: 'manual', property: 'prop-bay', arrival: '2026-10-01', departure: '2026-10-03', guest: 'Terry Part', payout: 400, booked: '2026-09-15' }),
  reservation('res-q', { platform: 'airbnb', property: 'prop-bay', arrival: '2025-12-01', departure: '2025-12-03', guest: 'Quill Early', payout: 99, booked: '2025-11-01' }),
];
const payout = (id, date, dollars) => ({ id, platform: 'airbnb', bank_account: 'Test Bank Checking 4321 (USD)', amount: { amount: Math.round(dollars * 100) }, date: `${date}T00:00:00.000000Z` });
const PAYOUTS = [
  payout('pay-1', '2026-03-04', 712.5),
  payout('pay-2', '2026-07-06', 250),
  payout('pay-3', '2026-07-06', 180),
  payout('pay-4', '2026-08-03', 100),
  payout('pay-5', '2026-08-03', 60),
  payout('pay-6', '2026-08-04', 40),
  payout('pay-7', '2026-08-04', 160),
];
// As Hospitable sends them: a stay's share is in amount; only the payout line has paid_out_amount.
const line = (id, payoutId, reservationId, dollars) => ({ id, type: 'Reservation', date: '2026-03-04T00:00:00+00:00', amount: { amount: Math.round(dollars * 100) }, paid_out_amount: null, payout: { id: payoutId }, reservation: { id: reservationId } });
const TRANSACTIONS = [
  { id: 'line-0', type: 'Payout', date: '2026-03-04T00:00:00+00:00', amount: null, paid_out_amount: { amount: 71250 }, payout: { id: 'pay-1' }, reservation: null },
  line('line-a', 'pay-1', 'res-a', 412.5),
  line('line-b', 'pay-1', 'res-b', 300),
  line('line-i', 'pay-2', 'res-i', 250),
  line('line-j', 'pay-3', 'res-j', 180),
  line('line-k', 'pay-4', 'res-k', 100),
  line('line-l', 'pay-5', 'res-l', 60),
  line('line-m', 'pay-6', 'res-m', 40),
  line('line-n', 'pay-7', 'res-n', 160),
];

async function fakeHospitable(url, options = {}) {
  const u = new URL(url);
  calls.push(u.pathname);
  assert.equal(u.origin, 'https://public.api.hospitable.com');
  if (options.headers?.Authorization !== `Bearer ${TOKEN}`) return new Response('{}', { status: 401 });
  const page = (data) => new Response(JSON.stringify({ data, meta: { current_page: 1, last_page: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v2/properties') return page(PROPERTIES);
  if (u.pathname === '/v2/reservations') {
    assert.deepEqual(u.searchParams.getAll('properties[]').sort(), ['prop-bay', 'prop-hill', 'prop-lake']);
    assert.match(u.searchParams.get('include'), /financials/);
    return page(RESERVATIONS);
  }
  if (u.pathname === '/v2/payouts') return page(PAYOUTS);
  if (u.pathname === '/v2/transactions') return page(TRANSACTIONS);
  return new Response('{}', { status: 404 });
}

const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => {
  const response = await call(route);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const txByDate = async (date) => (await get(`/api/bank/transactions?from=${date}&to=${date}&preset=all`)).transactions;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-stays-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true, secrets: fileSecretBox(dir), dataDir: dir, fetchImpl: fakeHospitable });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];

  const csv = [
    'Date,Description,Amount',
    '03/05/2026,AIRBNB PAYMENTS,712.50',
    '04/11/2026,HOMEAWAY.COM PAYMENT,880.00',
    '05/02/2026,VRBO PAYMENT,500.00',
    '05/04/2026,VRBO PAYMENT,500.00',
    '06/02/2026,AIRBNB 4455,640.00',
    '06/03/2026,COFFEE SHOP,-4.50',
    '06/05/2026,BOOKING.COM DES:ST-TEST01,660.00',
    '05/20/2026,INTEREST EARNED,0.42',
    '09/08/2026,BANK MOBILE DEPOSIT,1750.00',
    '09/20/2026,CHECK 1234,-500.00',
    '09/25/2026,ZELLE FROM T PART,150.00',
    '01/13/2026,AIRBNB PAYMENTS,550.00',
    '07/08/2026,AIRBNB PAYMENTS,430.00',
    '08/06/2026,AIRBNB PAYMENTS,200.00',
  ].join('\n');
  await post('/api/bank/import', { content: csv, fileName: 'checking.csv', newAccount: { name: 'Ops Checking', kind: 'checking', owner: 'business' } });
  db.raw.prepare("UPDATE bank_accounts SET last4 = '4321'").run();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a wrong token is refused and not kept', async () => {
  await assert.rejects(post('/api/settings/hospitable', { token: 'wrong-token-abcdefghijklmnopqrstuvwxyz' }), /refused the token/);
  assert.equal((await get('/api/settings/hospitable')).connected, false);
  const anonymous = await fetch(`${base}/api/stays`);
  assert.equal(anonymous.status, 401);
});

test('connecting reads properties, stays, guests and payouts', async () => {
  const { result, status } = await post('/api/settings/hospitable', { token: `Bearer ${TOKEN}` });
  assert.deepEqual(result.errors, []);
  assert.equal(result.properties, 3);
  assert.equal(result.stays, 20);
  assert.equal(status.connected, true);
  assert.equal(status.payouts, 7);
  // The token is kept encrypted, never as it was typed.
  const stored = db.raw.prepare("SELECT value FROM app_settings WHERE key = 'hospitable.token'").get().value;
  assert.ok(!stored.includes(TOKEN));

  const { stay, lines } = await get('/api/stays/res-a');
  assert.equal(stay.guest, 'Pat Example');
  assert.equal(stay.phone, '+1 555 0100');
  assert.equal(stay.property, 'Lake Cabin');
  assert.equal(stay.arrival, '2026-03-02');
  assert.equal(stay.departure, '2026-03-05');
  assert.equal(stay.nights, 3);
  assert.equal(stay.payout, 412.5);
  assert.equal(stay.cleaning, 80);
  assert.equal(stay.hostFees, -20);
  assert.ok(lines.some((l) => l.label === 'Cleaning fee'));
});

test('an Airbnb payout is matched to its deposit, and both stays it paid for show it', async () => {
  const [deposit] = await txByDate('2026-03-05');
  assert.deepEqual(
    deposit.stays.map((s) => s.guest),
    ['Pat Example', 'Sam Sample']
  );
  assert.equal(deposit.stays[0].property, 'Lake Cabin');
  const { stay, payouts } = await get('/api/stays/res-b');
  assert.equal(stay.paid, true);
  assert.equal(stay.payment, 'paid');
  assert.equal(stay.depositDate, '2026-03-05');
  assert.equal(payouts[0].deposit.id, deposit.id);
  assert.equal(payouts[0].matchSource, 'auto');
  assert.deepEqual(payouts[0].lines.map((l) => l.amount), [412.5, 300]);
  // The deposit's own view lists its stays.
  assert.deepEqual((await get(`/api/stays?deposit=${deposit.id}`)).stays.map((s) => s.id).sort(), ['res-a', 'res-b']);
});

test('Vrbo stays link to deposits of their amount; equal amounts pair up in date order', async () => {
  assert.equal((await get('/api/stays/res-c')).deposits[0].posted, '2026-04-11');
  assert.equal((await get('/api/stays/res-d')).deposits[0].posted, '2026-05-02');
  assert.equal((await get('/api/stays/res-e')).deposits[0].posted, '2026-05-04');
});

test("a deposit linked to one stay isn't offered for another, and only the platform's own deposits are", async () => {
  await post('/api/stays/res-e/unlink', { transactionId: (await get('/api/stays/res-e')).deposits[0].id });
  const offered = (await get('/api/stays/res-e')).suggestions;
  // res-d's deposit is taken; interest and coffee never name Vrbo.
  assert.ok(!offered.some((s) => s.posted === '2026-05-02'));
  assert.ok(offered.every((s) => /vrbo|homeaway/i.test(s.payee)));
  // Unlinked by hand, so it isn't offered again either.
  assert.ok(!offered.some((s) => s.posted === '2026-05-04'));
});

test('one deposit made of two Airbnb payouts links both', async () => {
  const [deposit] = await txByDate('2026-07-08');
  assert.deepEqual(deposit.stays.map((s) => s.guest).sort(), ['Ivy Combo', 'Jay Combo']);
  assert.equal((await get('/api/stays/res-j')).stay.payment, 'paid');
});

test('a deposit that adds up more than one way is a conflict, until the user picks', async () => {
  const k = await get('/api/stays/res-k');
  assert.equal(k.stay.payment, 'conflict');
  assert.equal(k.conflicts.length, 1);
  const [c] = k.conflicts;
  assert.equal(c.deposit.amount, 200);
  assert.deepEqual(c.options.map((o) => o.total), [200, 200]);
  assert.deepEqual(
    c.options.map((o) => o.subjects.length).sort(),
    [2, 3]
  );
  assert.deepEqual((await get('/api/stays?view=conflicts')).stays.map((s) => s.id).sort(), ['res-k', 'res-l', 'res-m', 'res-n']);
  // Nothing was linked while it's unclear.
  assert.equal((await txByDate('2026-08-06'))[0].stays.length, 0);

  // Only one of the offered ways can be picked.
  await assert.rejects(post('/api/stays/conflicts/resolve', { transactionId: c.deposit.id, subjects: ['payout:pay-4'] }), /no longer open/);
  const three = c.options.find((o) => o.subjects.length === 3);
  await post('/api/stays/conflicts/resolve', { transactionId: c.deposit.id, subjects: three.subjects });
  assert.deepEqual((await txByDate('2026-08-06'))[0].stays.map((s) => s.guest).sort(), ['Kit Clash', 'Lou Clash', 'Mo Clash']);
  const n = await get('/api/stays/res-n');
  assert.equal(n.conflicts.length, 0);
  assert.equal(n.stay.payment, 'missing');
});

test('older Airbnb stays with no payout record are matched as a group; ones before the bank records say so', async () => {
  const [deposit] = await txByDate('2026-01-13');
  assert.deepEqual(deposit.stays.map((s) => s.guest).sort(), ['Oak Early', 'Pine Early']);
  const q = (await get('/api/stays/res-q')).stay;
  assert.equal(q.payment, 'nobank');
  assert.ok(!(await get('/api/stays?view=unpaid')).stays.some((s) => s.id === 'res-q'));
});

test('Airbnb week by week: payouts against deposits, with unclaimed deposits', async () => {
  const { weeks, totals } = await get('/api/stays/airbnb-weeks?year=2026');
  const week = (monday) => weeks.find((w) => w.week === monday);
  // Payouts on Wednesday 4 March: the week starts Monday 2 March.
  assert.equal(week('2026-03-02').status, 'paid');
  assert.equal(week('2026-03-02').matched, 712.5);
  // The older stays: due the day after check-in.
  assert.equal(week('2026-01-05').items.length, 1);
  assert.equal(week('2026-01-12').items[0].status, 'paid');
  // An Airbnb deposit nothing claims.
  assert.equal(week('2026-06-01').status, 'extra');
  assert.equal(week('2026-06-01').unclaimed, 640);
  // The payout left over after the conflict was settled.
  assert.equal(week('2026-08-03').status, 'missing');
  assert.equal(week('2026-08-03').unmatched, 160);
  assert.ok(totals.weeksToCheck >= 2);
  await assert.rejects(get('/api/stays/airbnb-weeks?year=20x6'), /year must look like/);
});

test('Booking.com is matched at the payout plus its commission, which it bills separately', async () => {
  const g = await get('/api/stays/res-g');
  assert.equal(g.stay.payout, 640);
  assert.equal(g.stay.depositAmount, 660);
  assert.equal(g.deposits[0].posted, '2026-06-05');
  // The Airbnb deposit of the payout's amount was never used.
  assert.equal((await txByDate('2026-06-02'))[0].stays.length, 0);
  const unpaid = (await get('/api/stays?view=unpaid&property=prop-lake&property=prop-hill')).stays.map((s) => s.id);
  // res-s is the direct booking paid by cheque further down.
  assert.deepEqual(unpaid, ['res-s', 'res-e']);
});

test('unlinking by hand sticks, and linking it again works', async () => {
  const [deposit] = await txByDate('2026-03-05');
  await post('/api/stays/payouts/pay-1/unlink');
  app.stays.match();
  assert.equal((await get('/api/stays/res-a')).payouts[0].deposit, null);
  assert.equal((await txByDate('2026-03-05'))[0].stays.length, 0);
  await post('/api/stays/payouts/pay-1/link', { transactionId: deposit.id });
  assert.equal((await get('/api/stays/res-a')).payouts[0].matchSource, 'user');
});

test('the list filters by view, property, platform, year and guest, with totals per property', async () => {
  const all = await get('/api/stays?year=2026&property=prop-lake&property=prop-hill');
  assert.equal(all.totals.stays, 7);
  assert.equal(all.totals.nights, 3 + 3 + 4 + 2 + 2 + 3 + 3);
  assert.equal(all.totals.payout, 412.5 + 300 + 880 + 500 + 500 + 640 + 625);
  const lake = all.byProperty.find((p) => p.property === 'Lake Cabin');
  assert.equal(lake.stays, 4);
  assert.equal(lake.averageNightly, Math.round(((412.5 + 880 + 500 + 625) / 12) * 100) / 100);
  assert.deepEqual(all.options.properties.map((p) => p.name), ['Bay Studio', 'Hill House', 'Lake Cabin']);
  assert.deepEqual(all.options.platforms, ['airbnb', 'booking', 'direct', 'vrbo']);

  assert.deepEqual((await get('/api/stays?view=cancelled')).stays.map((s) => s.id), ['res-f']);
  assert.ok((await get('/api/stays?view=upcoming')).stays.some((s) => s.id === 'res-h'));
  assert.deepEqual((await get('/api/stays?platform=vrbo&year=2026')).stays.map((s) => s.id).sort(), ['res-c', 'res-d', 'res-e']);
  assert.deepEqual((await get('/api/stays?property=prop-hill&year=2026')).stays.map((s) => s.id).sort(), ['res-b', 'res-d', 'res-g']);
  assert.deepEqual((await get('/api/stays?q=kim')).stays.map((s) => s.id), ['res-d']);
  await assert.rejects(get('/api/stays?view=nonsense'), /Unknown view/);
});

test('a note is kept, and disconnecting forgets the token but keeps the stays', async () => {
  await post('/api/stays/res-c', { note: 'Asked for late check-out' });
  assert.equal((await get('/api/stays/res-c')).stay.note, 'Asked for late check-out');
  await post('/api/settings/hospitable/delete');
  assert.equal((await get('/api/settings/hospitable')).connected, false);
  assert.equal((await get('/api/stays?year=2026&property=prop-lake&property=prop-hill')).totals.stays, 7);
});

test('one check split between two stays, with the rest held as a security deposit and refunded', async () => {
  const r = await get('/api/stays/res-r');
  const check = r.suggestions.find((s) => s.payee.toUpperCase().includes('MOBILE DEPOSIT'));
  assert.equal(check.balance, 1750);
  // Only deposits that don't name a platform are offered for a direct booking.
  assert.ok(!r.suggestions.some((s) => /airbnb|vrbo|homeaway|booking/i.test(s.payee)));

  // With no amount, a link takes what the stay is due.
  await post('/api/stays/res-r/link', { transactionId: check.id });
  assert.equal((await get('/api/stays/res-r')).stay.payment, 'paid');

  // What's left of the check is offered to the other unit.
  const s = await get('/api/stays/res-s');
  const left = s.suggestions.find((x) => x.id === check.id);
  assert.equal(left.balance, 1125);
  await post('/api/stays/res-s/link', { transactionId: check.id });
  let after = await get('/api/stays/res-s');
  assert.equal(after.stay.payment, 'paid');
  const link = after.deposits.find((d) => d.id === check.id);
  assert.equal(link.share, 625);
  assert.equal(link.balance, 500);

  // Can't take more than is left.
  await assert.rejects(post('/api/stays/res-s/link', { transactionId: check.id, purpose: 'security', amount: 600 }), /Only 500.00 is left/);
  await post('/api/stays/res-s/link', { transactionId: check.id, purpose: 'security' });
  after = await get('/api/stays/res-s');
  assert.equal(after.stay.security, 500);
  assert.equal(after.deposits.find((d) => d.purpose === 'security').balance, 0);
  // All used, so nobody is offered it any more.
  assert.ok(!(await get('/api/stays/res-t')).suggestions.some((x) => x.id === check.id));

  // The cheque paid back is offered as the refund, and links.
  const refund = after.refundSuggestions[0];
  assert.equal(refund.amount, -500);
  assert.equal(refund.exact, true);
  await post('/api/stays/res-s/link', { transactionId: refund.id, purpose: 'refund' });
  after = await get('/api/stays/res-s');
  assert.equal(after.stay.refunded, 500);
  assert.equal(after.refundSuggestions.length, 0);
  // The deposit shows both stays.
  assert.deepEqual((await txByDate('2026-09-08'))[0].stays.map((x) => x.id).sort(), ['res-r', 'res-s']);
});

test('a stay paid only in part says what is still due', async () => {
  const t = await get('/api/stays/res-t');
  const zelle = t.suggestions.find((x) => x.balance === 150);
  await post('/api/stays/res-t/link', { transactionId: zelle.id });
  const after = await get('/api/stays/res-t');
  assert.equal(after.stay.payment, 'partial');
  assert.equal(after.stay.received, 150);
  assert.equal(after.due, 250);
  assert.ok((await get('/api/stays?view=unpaid')).stays.some((x) => x.id === 'res-t'));
  // Unlinking frees it again.
  await post('/api/stays/res-t/unlink', { transactionId: zelle.id });
  assert.equal((await get('/api/stays/res-t')).stay.received, 0);
});

test('the expected amount and each linked share can be changed by hand', async () => {
  // Hospitable says 400; the guest was charged 150 in the end.
  await post('/api/stays/res-t', { expected: 150 });
  let t = await get('/api/stays/res-t');
  assert.equal(t.stay.depositAmount, 150);
  assert.equal(t.stay.expectedEdited, true);
  assert.equal(t.stay.hospitableAmount, 400);
  assert.equal(t.due, 150);
  // Unlinked by hand in an earlier test, so it isn't offered; it can still be linked.
  assert.ok(!t.suggestions.some((x) => x.balance === 150));
  const [zelle] = await txByDate('2026-09-25');
  await post('/api/stays/res-t/link', { transactionId: zelle.id });
  assert.equal((await get('/api/stays/res-t')).stay.payment, 'paid');

  // Only part of the transfer was for the stay.
  await post('/api/stays/res-t/link', { transactionId: zelle.id, purpose: 'stay', amount: 100 });
  t = await get('/api/stays/res-t');
  assert.equal(t.stay.received, 100);
  assert.equal(t.stay.payment, 'partial');
  assert.equal(t.deposits[0].balance, 50);
  await assert.rejects(post('/api/stays/res-t/link', { transactionId: zelle.id, purpose: 'stay', amount: 151 }), /Only 150.00 is left/);

  // Back to Hospitable's figure.
  await post('/api/stays/res-t', { expected: null });
  t = await get('/api/stays/res-t');
  assert.equal(t.stay.expectedEdited, false);
  assert.equal(t.stay.depositAmount, 400);
  assert.equal(t.due, 300);
  await assert.rejects(post('/api/stays/res-t', { expected: -5 }), /expected/);
});

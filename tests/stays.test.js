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
];
const PAYOUTS = [{ id: 'pay-1', platform: 'airbnb', bank_account: 'Test Bank Checking 4321 (USD)', amount: { amount: 71250 }, date: '2026-03-04T00:00:00.000000Z' }];
const TRANSACTIONS = [
  { id: 'line-0', type: 'Payout', date: '2026-03-04T00:00:00+00:00', paid_out_amount: { amount: 71250 }, payout: { id: 'pay-1' }, reservation: null },
  { id: 'line-a', type: 'Reservation', date: '2026-03-04T00:00:00+00:00', paid_out_amount: { amount: 41250 }, payout: { id: 'pay-1' }, reservation: { id: 'res-a' } },
  { id: 'line-b', type: 'Reservation', date: '2026-03-04T00:00:00+00:00', paid_out_amount: { amount: 30000 }, payout: { id: 'pay-1' }, reservation: { id: 'res-b' } },
];

async function fakeHospitable(url, options = {}) {
  const u = new URL(url);
  calls.push(u.pathname);
  assert.equal(u.origin, 'https://public.api.hospitable.com');
  if (options.headers?.Authorization !== `Bearer ${TOKEN}`) return new Response('{}', { status: 401 });
  const page = (data) => new Response(JSON.stringify({ data, meta: { current_page: 1, last_page: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v2/properties') return page(PROPERTIES);
  if (u.pathname === '/v2/reservations') {
    assert.deepEqual(u.searchParams.getAll('properties[]').sort(), ['prop-hill', 'prop-lake']);
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
  assert.equal(result.properties, 2);
  assert.equal(result.stays, 8);
  assert.equal(status.connected, true);
  assert.equal(status.payouts, 1);
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

test('a Vrbo stay with one deposit of its amount links; two alike wait for the user', async () => {
  assert.equal((await get('/api/stays/res-c')).deposits[0].posted, '2026-04-11');
  const d = await get('/api/stays/res-d');
  assert.equal(d.deposits.length, 0);
  assert.deepEqual(d.suggestions.filter((s) => s.exact).map((s) => s.posted), ['2026-05-02', '2026-05-04']);

  // The user picks one; the other stay then has only one left, and it links.
  const picked = d.suggestions.find((s) => s.posted === '2026-05-02');
  await post('/api/stays/res-d/link', { transactionId: picked.id });
  app.stays.match();
  assert.equal((await get('/api/stays/res-e')).deposits[0].posted, '2026-05-04');
});

test("a deposit naming another platform isn't offered for a stay", async () => {
  const g = await get('/api/stays/res-g');
  assert.equal(g.deposits.length, 0);
  assert.ok(!g.suggestions.some((s) => /AIRBNB/i.test(s.payee)));
  const unpaid = (await get('/api/stays?view=unpaid')).stays.map((s) => s.id);
  assert.deepEqual(unpaid, ['res-g']);
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
  const all = await get('/api/stays?year=2026');
  assert.equal(all.totals.stays, 6);
  assert.equal(all.totals.nights, 3 + 3 + 4 + 2 + 2 + 3);
  assert.equal(all.totals.payout, 412.5 + 300 + 880 + 500 + 500 + 640);
  const lake = all.byProperty.find((p) => p.property === 'Lake Cabin');
  assert.equal(lake.stays, 3);
  assert.equal(lake.averageNightly, Math.round(((412.5 + 880 + 500) / 9) * 100) / 100);
  assert.deepEqual(all.options.properties.map((p) => p.name), ['Hill House', 'Lake Cabin']);
  assert.deepEqual(all.options.platforms, ['airbnb', 'booking', 'vrbo']);

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
  assert.equal((await get('/api/stays?year=2026')).totals.stays, 6);
});

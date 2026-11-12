// Stays: reservations from Hospitable with their guests and money, and the bank
// deposits that paid for them.
//
// Airbnb: Hospitable knows each payout (amount, date, the bank account's last four)
// and which reservations it paid for, so a payout is matched to one deposit and its
// stays follow. Vrbo, Booking.com and others: Hospitable has no payouts, so a stay's
// expected payout is matched to a deposit by amount and dates. Only clear matches link
// on their own; the rest are offered on the stay's page.
import type { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from '../secrets';
import type { BankStore } from '../bank/store';
import { incomeSource } from '../bank/merchant';
import { toCents } from '../bank/types';
import { HospitableError, hospitableClient } from './hospitable';
import type { HospitableReservation } from './hospitable';

type Fetch = typeof fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const KEY_TOKEN = 'hospitable.token';
const KEY_SUCCESS = 'hospitable.lastSuccess';
const KEY_ATTEMPT = 'hospitable.lastAttempt';
const KEY_ERRORS = 'hospitable.lastErrors';
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 2 * 60 * 1000;
const FIRST_YEAR = 2023;
const DAY_MS = 86400000;

export const PLATFORM_LABELS: Record<string, string> = {
  airbnb: 'Airbnb',
  vrbo: 'Vrbo',
  homeaway: 'Vrbo',
  booking: 'Booking.com',
  manual: 'Direct',
  direct: 'Direct',
};
export const STAY_VIEWS = ['all', 'upcoming', 'unpaid', 'conflicts', 'cancelled'] as const;
export type StayView = (typeof STAY_VIEWS)[number];

export interface StayFilters {
  view?: StayView;
  year?: string | null;
  property?: string[] | null;
  platform?: string[] | null;
  q?: string | null;
  deposit?: number | null;
}

const now = () => new Date().toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const cents = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value / 100 : null);
const sum = (list: { amount: number | null }[] | undefined) => {
  const values = (list || []).map((m) => m.amount).filter((n): n is number => typeof n === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) / 100 : null;
};
const round = (n: number) => Math.round(n * 100) / 100;
// The platform a deposit's description points to, in the same words as a stay's.
const platformGroup = (platform: string) => (platform === 'homeaway' ? 'vrbo' : platform === 'airbnb' || platform === 'vrbo' || platform === 'booking' ? platform : 'other');
const last4Of = (bankAccount: string | null | undefined) => /(\d{4})\D*$/.exec(bankAccount || '')?.[1] ?? null;

// How long after booking or arrival each platform's money can turn up.
function depositWindow(stay: Row): [string, string] {
  const booked = (stay.booked_at as string | null) || shift(stay.arrival, -60);
  switch (platformGroup(stay.platform)) {
    case 'airbnb':
      return [shift(stay.arrival, -3), shift(stay.arrival, 10)];
    case 'vrbo':
      return [shift(booked, -1), shift(stay.departure, 30)];
    case 'booking':
      return [booked, shift(stay.departure, 60)];
    default:
      return [shift(booked, -7), shift(stay.departure, 30)];
  }
}

// What the bank should receive for a stay. Booking.com pays the full amount and bills
// its commission separately, so its deposit is the payout plus the commission.
function depositAmount(stay: Row): number {
  const payout = Number(stay.payout) || 0;
  const fees = Number(stay.host_fees) || 0;
  return platformGroup(stay.platform) === 'booking' && fees < 0 ? round(payout - fees) : payout;
}

// A deposit is a stay's only if it names the stay's platform. Direct bookings can be
// any deposit that doesn't name a platform.
const ownDeposit = (platform: string, named: string) => (platformGroup(platform) === 'other' ? named === 'other' : named === platformGroup(platform));

function financialLines(r: HospitableReservation) {
  const f = r.financials;
  if (!f) return [];
  const lines: { side: 'guest' | 'host'; category: string; label: string; amount: number }[] = [];
  const add = (side: 'guest' | 'host', list: ({ amount: number | null; label?: string; category?: string } | undefined)[] | undefined, fallback = '') => {
    for (const m of list || []) if (m && typeof m.amount === 'number') lines.push({ side, category: m.category || '', label: (m.label || fallback || m.category || '').slice(0, 80), amount: m.amount / 100 });
  };
  add('guest', [f.guest?.accommodation], 'Accommodation');
  add('guest', f.guest?.fees);
  add('guest', f.guest?.discounts);
  add('guest', f.guest?.taxes);
  add('guest', [f.guest?.total_price], 'Total');
  add('host', [f.host?.accommodation], 'Accommodation');
  add('host', f.host?.guest_fees);
  add('host', f.host?.discounts);
  add('host', f.host?.host_fees);
  add('host', f.host?.adjustments);
  add('host', f.host?.taxes);
  add('host', [f.host?.revenue], 'Payout');
  return lines;
}

export function stayService({ db, bank, secrets, fetchImpl = fetch }: { db: DatabaseSync; bank: BankStore; secrets: SecretBox | null; fetchImpl?: Fetch }) {
  let running: Promise<SyncResult> | null = null;

  /* ---------- Connection ---------- */

  const token = () => {
    const sealed = bank.getSetting(KEY_TOKEN);
    if (sealed && secrets) return secrets.open(sealed);
    return process.env.HOSPITABLE_TOKEN?.trim() || null;
  };

  function status() {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM stays) AS stays, (SELECT COUNT(*) FROM stay_properties) AS properties,
                (SELECT COUNT(*) FROM stay_payouts) AS payouts, (SELECT COUNT(*) FROM stay_payouts WHERE transaction_id IS NOT NULL) AS payouts_linked`
      )
      .get() as Row;
    const fromEnvironment = !bank.getSetting(KEY_TOKEN) && Boolean(process.env.HOSPITABLE_TOKEN?.trim());
    return {
      connected: Boolean(token()),
      fromEnvironment,
      canStore: Boolean(secrets),
      lastSuccess: bank.getSetting(KEY_SUCCESS),
      lastAttempt: bank.getSetting(KEY_ATTEMPT),
      errors: JSON.parse(bank.getSetting(KEY_ERRORS) || '[]') as string[],
      syncing: Boolean(running),
      stays: counts.stays as number,
      properties: counts.properties as number,
      payouts: counts.payouts as number,
      payoutsLinked: counts.payouts_linked as number,
    };
  }

  async function connect(value: string) {
    const text = value.trim().replace(/^Bearer\s+/i, '');
    if (!/^[\w.~+/=-]{20,4096}$/.test(text)) throw new Error("That doesn't look like a Hospitable token. Copy the whole token.");
    if (!secrets) throw new Error('This server has nowhere safe to keep the token.');
    // Checked before it's kept, so a wrong token says so straight away.
    try {
      await hospitableClient(text, fetchImpl).properties();
    } catch (err) {
      throw new Error((err as Error).message);
    }
    bank.setSetting(KEY_TOKEN, secrets.seal(text));
    bank.setSetting(KEY_ERRORS, null);
    return sync({ force: true });
  }

  function disconnect() {
    for (const key of [KEY_TOKEN, KEY_ATTEMPT, KEY_ERRORS]) bank.setSetting(key, null);
  }

  /* ---------- Sync ---------- */

  interface SyncResult {
    properties: number;
    stays: number;
    newStays: number;
    payouts: number;
    linked: number;
    errors: string[];
  }

  async function runSync(): Promise<SyncResult> {
    const key = token();
    if (!key) throw new Error('Hospitable is not connected.');
    bank.setSetting(KEY_ATTEMPT, now());
    const result: SyncResult = { properties: 0, stays: 0, newStays: 0, payouts: 0, linked: 0, errors: [] };
    try {
      const api = hospitableClient(key, fetchImpl);
      const properties = await api.properties();
      const end = `${new Date().getUTCFullYear() + 2}-12-31`;
      const reservations = await api.reservations(
        properties.map((p) => p.id),
        `${FIRST_YEAR}-01-01`,
        end
      );
      const payouts = await api.payouts();
      const lines = await api.transactions();
      const stamp = now();

      db.exec('BEGIN');
      try {
        const putProperty = db.prepare(
          `INSERT INTO stay_properties (id, name, public_name, city, state, synced_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, public_name = excluded.public_name, city = excluded.city, state = excluded.state, synced_at = excluded.synced_at`
        );
        for (const p of properties) {
          putProperty.run(p.id, (p.name || p.public_name || 'Property').slice(0, 120), p.public_name?.slice(0, 160) ?? null, p.address?.city?.slice(0, 80) ?? null, p.address?.state?.slice(0, 40) ?? null, stamp);
          result.properties++;
        }

        const known = new Set((db.prepare('SELECT id FROM stays').all() as Row[]).map((r) => r.id as string));
        const knownProperties = new Set(properties.map((p) => p.id));
        const putStay = db.prepare(
          `INSERT INTO stays (id, code, platform, property_id, status, booked_at, arrival, departure, check_in, check_out, nights,
             guest_first, guest_last, guest_email, guest_phone, guest_location, adults, children, infants, pets,
             currency, guest_total, accommodation, cleaning, host_fees, taxes, payout, financials, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET code = excluded.code, platform = excluded.platform, property_id = excluded.property_id, status = excluded.status,
             booked_at = excluded.booked_at, arrival = excluded.arrival, departure = excluded.departure, check_in = excluded.check_in, check_out = excluded.check_out,
             nights = excluded.nights, guest_first = excluded.guest_first, guest_last = excluded.guest_last, guest_email = excluded.guest_email,
             guest_phone = excluded.guest_phone, guest_location = excluded.guest_location, adults = excluded.adults, children = excluded.children,
             infants = excluded.infants, pets = excluded.pets, currency = excluded.currency, guest_total = excluded.guest_total,
             accommodation = excluded.accommodation, cleaning = excluded.cleaning, host_fees = excluded.host_fees, taxes = excluded.taxes,
             payout = excluded.payout, financials = excluded.financials, synced_at = excluded.synced_at`
        );
        for (const r of reservations) {
          if (!r.id || !/^\d{4}-\d{2}-\d{2}/.test(r.arrival_date || '') || !/^\d{4}-\d{2}-\d{2}/.test(r.departure_date || '')) continue;
          const f = r.financials;
          const propertyId = r.properties?.find((p) => knownProperties.has(p.id))?.id ?? null;
          const guestFees = f?.guest?.fees || [];
          const cleaning = sum(guestFees.filter((m) => /clean/i.test(`${m.label} ${m.category}`)));
          const g = r.guest || {};
          putStay.run(
            r.id,
            r.code?.slice(0, 40) ?? null,
            (r.platform || 'other').toLowerCase().slice(0, 20),
            propertyId,
            (r.status || 'unknown').toLowerCase().slice(0, 40),
            r.booking_date ? r.booking_date.slice(0, 10) : null,
            r.arrival_date.slice(0, 10),
            r.departure_date.slice(0, 10),
            r.check_in?.slice(0, 40) ?? null,
            r.check_out?.slice(0, 40) ?? null,
            Number.isFinite(r.nights) ? Number(r.nights) : Math.max(0, dayNumber(r.departure_date) - dayNumber(r.arrival_date)),
            g.first_name?.slice(0, 80) ?? null,
            g.last_name?.slice(0, 80) ?? null,
            g.email?.slice(0, 160) ?? null,
            g.phone_numbers?.find(Boolean)?.slice(0, 40) ?? null,
            g.location?.slice(0, 120) ?? null,
            r.guests?.adult_count ?? null,
            r.guests?.child_count ?? null,
            r.guests?.infant_count ?? null,
            r.guests?.pet_count ?? null,
            (f?.currency || 'USD').toUpperCase().slice(0, 3),
            cents(f?.guest?.total_price?.amount),
            cents(f?.host?.accommodation?.amount),
            cleaning,
            sum(f?.host?.host_fees),
            sum(f?.host?.taxes),
            cents(f?.host?.revenue?.amount),
            JSON.stringify(financialLines(r)),
            stamp
          );
          result.stays++;
          if (!known.has(r.id)) result.newStays++;
        }

        const putPayout = db.prepare(
          `INSERT INTO stay_payouts (id, platform, amount, paid_on, bank_account, synced_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET platform = excluded.platform, amount = excluded.amount, paid_on = excluded.paid_on, bank_account = excluded.bank_account, synced_at = excluded.synced_at`
        );
        const payoutIds = new Set<string>();
        for (const p of payouts) {
          const amount = cents(p.amount?.amount);
          if (!p.id || amount === null || !/^\d{4}-\d{2}-\d{2}/.test(p.date || '')) continue;
          putPayout.run(p.id, (p.platform || 'airbnb').toLowerCase().slice(0, 20), amount, p.date.slice(0, 10), p.bank_account?.slice(0, 120) ?? null, stamp);
          payoutIds.add(p.id);
          result.payouts++;
        }
        const stayIds = new Set((db.prepare('SELECT id FROM stays').all() as Row[]).map((r) => r.id as string));
        const putLine = db.prepare(
          `INSERT INTO stay_payout_lines (id, payout_id, stay_id, type, amount, posted) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET payout_id = excluded.payout_id, stay_id = excluded.stay_id, type = excluded.type, amount = excluded.amount, posted = excluded.posted`
        );
        for (const t of lines) {
          // A "Payout" line is the payout itself; the others are what it paid for.
          if (!t.id || !t.payout?.id || !payoutIds.has(t.payout.id) || /^payout$/i.test(t.type || '')) continue;
          // Each stay's share is in amount; paid_out_amount is only on the payout line itself.
          const amount = cents(t.amount?.amount ?? t.paid_out_amount?.amount);
          if (amount === null) continue;
          const stayId = t.reservation?.id && stayIds.has(t.reservation.id) ? t.reservation.id : null;
          putLine.run(t.id, t.payout.id, stayId, (t.type || 'Other').slice(0, 60), amount, t.date ? t.date.slice(0, 10) : null);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      result.linked = match();
      bank.setSetting(KEY_SUCCESS, now());
    } catch (err) {
      if (!(err instanceof HospitableError)) console.error('Hospitable sync failed:', err);
      result.errors.push((err as Error).message);
    }
    bank.setSetting(KEY_ERRORS, JSON.stringify(result.errors.slice(0, 10)));
    return result;
  }

  function sync({ force = false } = {}): Promise<SyncResult> {
    if (running) return running;
    const last = bank.getSetting(KEY_ATTEMPT);
    if (!force && last && Date.now() - Date.parse(last) < MIN_GAP_MS) return Promise.reject(new Error('Hospitable was checked a moment ago. Try again in a couple of minutes.'));
    running = runSync().finally(() => {
      running = null;
    });
    return running;
  }

  function due(at = new Date()) {
    if (!token() || running) return false;
    const last = bank.getSetting(KEY_ATTEMPT);
    return !last || at.getTime() - Date.parse(last) > SYNC_EVERY_MS;
  }

  /* ---------- Matching deposits ---------- */

  // A deposit is free when nothing else claims it.
  const FREE = `NOT EXISTS (SELECT 1 FROM stay_payouts x WHERE x.transaction_id = t.id) AND NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.transaction_id = t.id)`;
  // What's left of a transaction for stays: a deposit less what stays and security
  // deposits took, or a payment out less what refunds took.
  const BALANCE = `ABS(t.amount) - COALESCE((SELECT SUM(d.amount) FROM stay_deposits d WHERE d.transaction_id = t.id), 0)`;
  const MAX_GROUP = 6;
  const MAX_POOL = 18;

  // For the stay and payout pages: deposits near a payout's date.
  function payoutCandidates(payout: Row, exactOnly = true) {
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.name AS account, a.last4 FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount > 0 AND t.kind = 'normal' AND t.posted BETWEEN ? AND ?
           ${exactOnly ? 'AND CAST(ROUND(t.amount * 100) AS INTEGER) = ?' : ''}
           AND NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.transaction_id = t.id)
           AND NOT EXISTS (SELECT 1 FROM stay_payouts x WHERE x.transaction_id = t.id AND x.id != ?)
           AND NOT EXISTS (SELECT 1 FROM stay_link_rejections j WHERE j.subject = ? AND j.transaction_id = t.id)
         ORDER BY t.posted`
      )
      .all(shift(payout.paid_on, -2), shift(payout.paid_on, exactOnly ? 7 : 14), ...(exactOnly ? [toCents(payout.amount)] : []), payout.id, `payout:${payout.id}`) as Row[];
    const last4 = last4Of(payout.bank_account);
    const sameAccount = last4 ? rows.filter((r) => r.last4 === last4) : [];
    return (sameAccount.length ? sameAccount : rows).filter((r) => incomeSource(`${r.description} ${r.payee || ''}`) === 'airbnb');
  }

  function stayCandidates(stay: Row, exactOnly = true) {
    const [from, to] = depositWindow(stay);
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.name AS account, ${BALANCE} AS balance FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount > 0 AND t.kind = 'normal' AND t.posted BETWEEN ? AND ?
           ${exactOnly ? 'AND CAST(ROUND(t.amount * 100) AS INTEGER) = ?' : ''}
           AND NOT EXISTS (SELECT 1 FROM stay_payouts x WHERE x.transaction_id = t.id)
           AND NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.transaction_id = t.id AND d.stay_id = ?)
           AND ${BALANCE} > 0.005
           AND NOT EXISTS (SELECT 1 FROM stay_link_rejections j WHERE j.subject = ? AND j.transaction_id = t.id)
         ORDER BY t.posted`
      )
      .all(from, to, ...(exactOnly ? [toCents(depositAmount(stay))] : []), stay.id, `stay:${stay.id}`) as Row[];
    return rows.filter((r) => ownDeposit(stay.platform, incomeSource(`${r.description} ${r.payee || ''}`)));
  }

  // Stays whose money Hospitable has no payout record for.
  function staysWithoutPayouts() {
    const earliest = (db.prepare(`SELECT MIN(paid_on) AS d FROM stay_payouts`).get() as Row).d as string | null;
    return db
      .prepare(
        `SELECT s.* FROM stays s
         WHERE s.status = 'accepted' AND s.payout > 0
           AND NOT EXISTS (SELECT 1 FROM stay_payout_lines l WHERE l.stay_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.stay_id = s.id)
           AND (s.platform != 'airbnb' OR ? IS NULL OR s.arrival < ?)
         ORDER BY s.arrival, s.id`
      )
      .all(earliest, earliest) as Row[];
  }

  // Up to two ways of making `target` cents from some of `amounts` (2 to MAX_GROUP of
  // them). Two is enough to know it isn't clear.
  function groupsMaking(target: number, amounts: number[]) {
    const order = amounts.map((a, i) => [a, i] as const).filter(([a]) => a > 0 && a < target).sort((x, y) => y[0] - x[0]);
    const found: number[][] = [];
    const seen = new Set<string>();
    const pick: number[] = [];
    const walk = (start: number, left: number) => {
      if (found.length > 1) return;
      if (left === 0) {
        if (pick.length < 2) return;
        // The same amounts in another order, or equal amounts swapped, aren't a different answer.
        const key = pick.map((i) => amounts[i]).sort((a, b) => a - b).join(',');
        if (seen.has(key)) return;
        seen.add(key);
        found.push([...pick]);
        return;
      }
      if (pick.length === MAX_GROUP) return;
      for (let k = start; k < order.length; k++) {
        const [a, i] = order[k];
        if (a > left) continue;
        pick.push(i);
        walk(k + 1, left - a);
        pick.pop();
        if (found.length > 1) return;
      }
    };
    walk(0, target);
    return found;
  }

  interface Deposit {
    id: number;
    posted: string;
    cents: number;
    last4: string | null;
    named: string;
  }
  const freeDeposits = (from: string) =>
    (
      db
        .prepare(
          `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.last4 FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
           WHERE t.amount > 0 AND t.kind = 'normal' AND t.posted >= ? AND ${FREE} ORDER BY t.posted, t.id`
        )
        .all(from) as Row[]
    ).map((r): Deposit => ({ id: r.id, posted: r.posted, cents: toCents(r.amount), last4: r.last4 ?? null, named: incomeSource(`${r.description} ${r.payee || ''}`) }));
  const rejectedSet = () => new Set((db.prepare('SELECT subject, transaction_id FROM stay_link_rejections').all() as Row[]).map((r) => `${r.subject}|${r.transaction_id}`));
  const between = (date: string, from: string, to: string) => date >= from && date <= to;

  function conflict(transactionId: number, options: string[][], reason: string) {
    const subjects = [...new Set(options.flat())];
    const put = db.prepare('INSERT OR REPLACE INTO stay_conflicts (subject, transaction_id, reason, options) VALUES (?, ?, ?, ?)');
    for (const subject of subjects) put.run(subject, transactionId, reason, JSON.stringify(options));
  }

  // Airbnb payouts to deposits: one for one by amount, in date order, so repeated
  // amounts pair up with the right week; then deposits that are several payouts added up.
  function matchPayouts() {
    let linked = 0;
    const payouts = db.prepare(`SELECT * FROM stay_payouts WHERE transaction_id IS NULL ORDER BY paid_on, id`).all() as Row[];
    if (!payouts.length) return 0;
    const rejected = rejectedSet();
    const deposits = freeDeposits(shift(payouts[0].paid_on, -2)).filter((d) => d.named === 'airbnb' || d.named === 'other');
    const used = new Set<number>();
    const link = db.prepare(`UPDATE stay_payouts SET transaction_id = ?, match_source = 'auto' WHERE id = ? AND transaction_id IS NULL`);
    const fits = (p: Row, d: Deposit) => {
      const last4 = last4Of(p.bank_account);
      return !used.has(d.id) && (!last4 || !d.last4 || d.last4 === last4) && !rejected.has(`payout:${p.id}|${d.id}`);
    };
    const left: Row[] = [];
    for (const p of payouts) {
      const cents = toCents(p.amount);
      const options = deposits.filter((d) => d.named === 'airbnb' && d.cents === cents && fits(p, d) && between(d.posted, shift(p.paid_on, -2), shift(p.paid_on, 7)));
      // A deposit that says Airbnb is preferred over one that doesn't say; then the earliest.
      const best = options[0] ?? null;
      if (best) {
        link.run(best.id, p.id);
        used.add(best.id);
        linked++;
      } else left.push(p);
    }
    // Several payouts in one deposit.
    for (const d of deposits) {
      if (used.has(d.id) || d.named !== 'airbnb' || !left.length) continue;
      const pool = left.filter((p) => fits(p, d) && between(p.paid_on, shift(d.posted, -7), shift(d.posted, 2))).slice(0, MAX_POOL);
      if (pool.length < 2) continue;
      const groups = groupsMaking(d.cents, pool.map((p) => toCents(p.amount)));
      if (groups.length === 1) {
        for (const i of groups[0]) {
          link.run(d.id, pool[i].id);
          left.splice(left.indexOf(pool[i]), 1);
          linked++;
        }
        used.add(d.id);
      } else if (groups.length > 1) {
        conflict(d.id, groups.map((g) => g.map((i) => `payout:${pool[i].id}`)), 'payouts');
      }
    }
    return linked;
  }

  // Stays Hospitable has no payout for: one for one by amount, then deposits that are
  // several stays added up (Airbnb before Hospitable's payout history, Vrbo, others).
  function matchStays() {
    let linked = 0;
    const stays = staysWithoutPayouts();
    if (!stays.length) return 0;
    const rejected = rejectedSet();
    const deposits = freeDeposits(shift(stays[0].booked_at || stays[0].arrival, -60));
    const used = new Set<number>();
    const insert = db.prepare(`INSERT OR IGNORE INTO stay_deposits (stay_id, transaction_id, purpose, amount, source, created_at) VALUES (?, ?, 'stay', ?, 'auto', ?)`);
    const link = { run: (stayId: string, txId: number, at: string) => insert.run(stayId, txId, depositAmount(stays.find((s) => s.id === stayId) as Row), at) };
    const fits = (s: Row, d: Deposit) => {
      const [from, to] = depositWindow(s);
      return !used.has(d.id) && between(d.posted, from, to) && ownDeposit(s.platform, d.named) && !rejected.has(`stay:${s.id}|${d.id}`);
    };
    const left: Row[] = [];
    for (const s of stays) {
      const cents = toCents(depositAmount(s));
      const expected = shift(s.arrival, 1);
      const options = deposits
        .filter((d) => d.cents === cents && fits(s, d))
        .sort((a, b) => Math.abs(dayNumber(a.posted) - dayNumber(expected)) - Math.abs(dayNumber(b.posted) - dayNumber(expected)));
      // One that names the platform is enough; one that doesn't has to be the only one.
      const named = options.filter((d) => d.named !== 'other');
      const best = named[0] || (options.length === 1 ? options[0] : null);
      if (best) {
        link.run(s.id, best.id, now());
        used.add(best.id);
        linked++;
      } else left.push(s);
    }
    // Several stays in one deposit: only deposits that name the platform.
    for (const d of deposits) {
      if (used.has(d.id) || d.named === 'other' || !left.length) continue;
      const pool = left
        .filter((s) => platformGroup(s.platform) === d.named && fits(s, d))
        .sort((a, b) => Math.abs(dayNumber(a.arrival) - dayNumber(d.posted)) - Math.abs(dayNumber(b.arrival) - dayNumber(d.posted)))
        .slice(0, MAX_POOL);
      if (pool.length < 2) continue;
      const groups = groupsMaking(d.cents, pool.map((s) => toCents(depositAmount(s))));
      if (groups.length === 1) {
        for (const i of groups[0]) {
          link.run(pool[i].id, d.id, now());
          left.splice(left.indexOf(pool[i]), 1);
          linked++;
        }
        used.add(d.id);
      } else if (groups.length > 1) {
        conflict(d.id, groups.map((g) => g.map((i) => `stay:${pool[i].id}`)), 'stays');
      }
    }
    return linked;
  }

  // Links what is clear. Where a deposit could be made up more than one way, nothing
  // is linked and the choice is kept as a conflict for the user. Run after every
  // Hospitable sync and every bank import.
  function match() {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM stay_conflicts');
      const linked = matchPayouts() + matchStays();
      // A conflict whose deposit or subjects got linked in the meantime is settled.
      db.exec(`DELETE FROM stay_conflicts WHERE EXISTS (SELECT 1 FROM stay_payouts x WHERE x.transaction_id = stay_conflicts.transaction_id)
                 OR EXISTS (SELECT 1 FROM stay_deposits d WHERE d.transaction_id = stay_conflicts.transaction_id)`);
      db.exec('COMMIT');
      return linked;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------- Reading ---------- */

  function whereFor(filters: StayFilters) {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const view = filters.view || 'all';
    if (view === 'cancelled') clauses.push(`s.status != 'accepted'`);
    else clauses.push(`s.status = 'accepted'`);
    if (view === 'upcoming') {
      clauses.push('s.departure >= ?');
      params.push(today());
    }
    if (view === 'unpaid' || view === 'conflicts') {
      clauses.push(`s.payout > 0 AND s.arrival <= ? AND NOT (${PAID})`);
      params.push(today());
    }
    if (filters.year) {
      clauses.push(`substr(s.arrival, 1, 4) = ?`);
      params.push(filters.year);
    }
    if (filters.property?.length) {
      clauses.push(`s.property_id IN (${filters.property.map(() => '?').join(', ')})`);
      params.push(...filters.property);
    }
    if (filters.platform?.length) {
      const list = filters.platform.flatMap((p) => (p === 'vrbo' ? ['vrbo', 'homeaway'] : p === 'direct' ? ['manual', 'direct'] : [p]));
      clauses.push(`s.platform IN (${list.map(() => '?').join(', ')})`);
      params.push(...list);
    }
    if (filters.q) {
      const like = `%${filters.q.toLowerCase()}%`;
      clauses.push(
        `(LOWER(COALESCE(s.guest_first, '') || ' ' || COALESCE(s.guest_last, '')) LIKE ? OR LOWER(COALESCE(s.code, '')) LIKE ? OR COALESCE(s.guest_phone, '') LIKE ? OR LOWER(COALESCE(s.guest_email, '')) LIKE ?)`
      );
      params.push(like, like, like, like);
    }
    if (filters.deposit) {
      // The deposit view shows its stays whatever their status.
      clauses.length = 0;
      params.length = 0;
      clauses.push(`s.id IN (SELECT stay_id FROM stay_deposits WHERE transaction_id = ? UNION SELECT l.stay_id FROM stay_payout_lines l JOIN stay_payouts p ON p.id = l.payout_id WHERE p.transaction_id = ?)`);
      params.push(filters.deposit, filters.deposit);
    }
    return { sql: `WHERE ${clauses.join(' AND ')}`, params };
  }

  const EXPECTED = `(CASE WHEN s.platform = 'booking' AND s.host_fees < 0 THEN s.payout - s.host_fees ELSE s.payout END)`;
  const RECEIVED = `COALESCE((SELECT SUM(d.amount) FROM stay_deposits d WHERE d.stay_id = s.id AND d.purpose = 'stay'), 0)`;
  // Within a dollar counts as paid: banks and platforms round differently.
  const PAID = `(${RECEIVED} > 0 AND ${RECEIVED} >= ${EXPECTED} - 1) OR EXISTS (SELECT 1 FROM stay_payout_lines l JOIN stay_payouts p ON p.id = l.payout_id WHERE l.stay_id = s.id AND p.transaction_id IS NOT NULL)`;

  // The first day the bank records cover: money due before then can't be checked.
  const bankStart = () => ((db.prepare('SELECT MIN(posted) AS d FROM bank_transactions WHERE amount > 0').get() as Row).d as string | null) ?? null;
  // Days after the payout (or check-in) before money not seen in the bank counts as missing.
  const GRACE_DAYS = 7;

  function paymentOf(r: Row, start: string | null) {
    if (r.status !== 'accepted') return 'none' as const;
    if (r.paid) return 'paid' as const;
    if (r.conflict) return 'conflict' as const;
    if (r.received > 0) return 'partial' as const;
    if (!r.payout) return 'none' as const;
    const expected = r.expected_on as string;
    if (expected > today()) return 'upcoming' as const;
    if (start && expected < start) return 'nobank' as const;
    if (shift(expected, GRACE_DAYS) >= today()) return 'due' as const;
    return 'missing' as const;
  }

  const toStay = (r: Row, start: string | null) => {
    const paid = Boolean(r.paid);
    return {
      id: r.id as string,
      code: r.code as string | null,
      platform: r.platform as string,
      platformLabel: PLATFORM_LABELS[r.platform] || r.platform,
      propertyId: r.property_id as string | null,
      property: r.property_name as string | null,
      status: r.status as string,
      bookedAt: r.booked_at as string | null,
      arrival: r.arrival as string,
      departure: r.departure as string,
      checkIn: r.check_in as string | null,
      checkOut: r.check_out as string | null,
      nights: r.nights as number,
      guest: [r.guest_first, r.guest_last].filter(Boolean).join(' ') || null,
      phone: r.guest_phone as string | null,
      email: r.guest_email as string | null,
      location: r.guest_location as string | null,
      adults: r.adults as number | null,
      children: r.children as number | null,
      infants: r.infants as number | null,
      pets: r.pets as number | null,
      currency: r.currency as string,
      guestTotal: r.guest_total as number | null,
      accommodation: r.accommodation as number | null,
      cleaning: r.cleaning as number | null,
      hostFees: r.host_fees as number | null,
      taxes: r.taxes as number | null,
      payout: r.payout as number | null,
      // What the bank should receive: for Booking.com, before its commission.
      depositAmount: r.payout === null ? null : depositAmount(r),
      note: r.note as string | null,
      paid,
      received: round(Number(r.received) || 0),
      // Part of a deposit held as a security deposit, and what's been paid back.
      security: round(Number(r.security) || 0),
      refunded: round(Number(r.refunded) || 0),
      // paid, partial (some of it), conflict (more than one way it could have been paid), due (on its way),
      // missing, nobank (before the bank records start), upcoming, or none.
      payment: paymentOf(r, start),
      expectedOn: r.expected_on as string,
      depositDate: (r.deposit_date as string | null) ?? null,
    };
  };

  const CONFLICT = `EXISTS (SELECT 1 FROM stay_conflicts c WHERE c.subject = 'stay:' || s.id OR c.subject IN (SELECT 'payout:' || l.payout_id FROM stay_payout_lines l WHERE l.stay_id = s.id))`;
  const SELECT = `SELECT s.*, p.name AS property_name, (${PAID}) AS paid, (${CONFLICT}) AS conflict, ${RECEIVED} AS received,
      COALESCE((SELECT SUM(d.amount) FROM stay_deposits d WHERE d.stay_id = s.id AND d.purpose = 'security'), 0) AS security,
      COALESCE((SELECT SUM(d.amount) FROM stay_deposits d WHERE d.stay_id = s.id AND d.purpose = 'refund'), 0) AS refunded,
      COALESCE((SELECT MIN(po.paid_on) FROM stay_payout_lines l JOIN stay_payouts po ON po.id = l.payout_id WHERE l.stay_id = s.id), date(s.arrival, '+1 day')) AS expected_on,
      COALESCE((SELECT MIN(t.posted) FROM stay_deposits d JOIN bank_transactions t ON t.id = d.transaction_id WHERE d.stay_id = s.id),
               (SELECT MIN(t.posted) FROM stay_payout_lines l JOIN stay_payouts po ON po.id = l.payout_id JOIN bank_transactions t ON t.id = po.transaction_id WHERE l.stay_id = s.id)) AS deposit_date
    FROM stays s LEFT JOIN stay_properties p ON p.id = s.property_id`;

  function list(filters: StayFilters) {
    const { sql, params } = whereFor(filters);
    const asc = filters.view === 'upcoming';
    const rows = db.prepare(`${SELECT} ${sql} ORDER BY s.arrival ${asc ? 'ASC' : 'DESC'}, s.id LIMIT 2000`).all(...params) as Row[];
    const start = bankStart();
    let stays = rows.map((r) => toStay(r, start));
    if (filters.view === 'unpaid' && !filters.deposit) stays = stays.filter((s) => s.payment === 'missing' || s.payment === 'conflict' || s.payment === 'partial');
    if (filters.view === 'conflicts' && !filters.deposit) stays = stays.filter((s) => s.payment === 'conflict');

    // Totals for what's listed, and per property.
    const accepted = stays.filter((s) => s.status === 'accepted');
    const totals = {
      stays: accepted.length,
      nights: accepted.reduce((n, s) => n + (s.nights || 0), 0),
      payout: round(accepted.reduce((n, s) => n + (s.payout || 0), 0)),
      paid: round(accepted.reduce((n, s) => n + (s.paid ? s.payout || 0 : s.received), 0)),
      missing: round(accepted.filter((s) => s.payment === 'missing' || s.payment === 'partial').reduce((n, s) => n + (s.depositAmount || 0) - s.received, 0)),
      missingCount: accepted.filter((s) => s.payment === 'missing' || s.payment === 'partial').length,
      conflictCount: accepted.filter((s) => s.payment === 'conflict').length,
      due: round(accepted.filter((s) => s.payment === 'due').reduce((n, s) => n + (s.payout || 0), 0)),
      noBank: round(accepted.filter((s) => s.payment === 'nobank').reduce((n, s) => n + (s.payout || 0), 0)),
      noBankCount: accepted.filter((s) => s.payment === 'nobank').length,
      bankStart: start,
      guestTotal: round(accepted.reduce((n, s) => n + (s.guestTotal || 0), 0)),
    };
    const byProperty = new Map<string, { property: string; propertyId: string | null; stays: number; nights: number; payout: number; accommodation: number }>();
    for (const s of accepted) {
      const key = s.propertyId || '';
      const row = byProperty.get(key) || { property: s.property || 'Unknown property', propertyId: s.propertyId, stays: 0, nights: 0, payout: 0, accommodation: 0 };
      row.stays++;
      row.nights += s.nights || 0;
      row.payout = round(row.payout + (s.payout || 0));
      row.accommodation = round(row.accommodation + (s.accommodation || 0));
      byProperty.set(key, row);
    }
    // Nights booked out of the nights in the year, for a year's view.
    const daysInYear = filters.year ? (Number(filters.year) % 4 === 0 ? 366 : 365) : null;
    const properties = [...byProperty.values()]
      .sort((a, b) => b.payout - a.payout)
      .map((p) => ({ ...p, averageNightly: p.nights ? round(p.accommodation / p.nights) : null, occupancy: daysInYear ? Math.round((p.nights / daysInYear) * 1000) / 10 : null }));
    return { stays, totals, byProperty: properties };
  }

  function options() {
    return {
      properties: db.prepare('SELECT id, name FROM stay_properties ORDER BY name').all() as { id: string; name: string }[],
      platforms: [...new Set((db.prepare('SELECT DISTINCT platform FROM stays').all() as Row[]).map((r) => (r.platform === 'homeaway' ? 'vrbo' : r.platform === 'manual' ? 'direct' : r.platform) as string))].sort(),
      years: (db.prepare(`SELECT DISTINCT substr(arrival, 1, 4) AS y FROM stays ORDER BY y DESC`).all() as Row[]).map((r) => r.y as string),
    };
  }

  const txRow = (r: Row) => ({ id: r.id as number, posted: r.posted as string, amount: r.amount as number, payee: (r.payee || r.description) as string, account: r.account as string });

  function get(id: string) {
    const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const stay = toStay(row, bankStart());
    const lines = JSON.parse(row.financials || '[]') as { side: string; category: string; label: string; amount: number }[];

    // Airbnb payouts that paid for this stay, with what else each one covered.
    const payouts = (
      db
        .prepare(
          `SELECT DISTINCT p.*, t.posted AS tx_posted, t.amount AS tx_amount, t.payee AS tx_payee, t.description AS tx_description, a.name AS tx_account
           FROM stay_payout_lines l JOIN stay_payouts p ON p.id = l.payout_id
           LEFT JOIN bank_transactions t ON t.id = p.transaction_id LEFT JOIN bank_accounts a ON a.id = t.account_id
           WHERE l.stay_id = ? ORDER BY p.paid_on`
        )
        .all(id) as Row[]
    ).map((p) => ({
      id: p.id as string,
      amount: p.amount as number,
      paidOn: p.paid_on as string,
      bankAccount: last4Of(p.bank_account),
      matchSource: p.match_source as string | null,
      deposit: p.transaction_id ? { id: p.transaction_id as number, posted: p.tx_posted, amount: p.tx_amount, payee: p.tx_payee || p.tx_description, account: p.tx_account } : null,
      lines: (
        db
          .prepare(
            `SELECT l.type, l.amount, l.stay_id, s.guest_first, s.guest_last, s.arrival FROM stay_payout_lines l LEFT JOIN stays s ON s.id = l.stay_id WHERE l.payout_id = ? ORDER BY s.arrival, l.id`
          )
          .all(p.id) as Row[]
      ).map((l) => ({ type: l.type as string, amount: l.amount as number, stayId: l.stay_id as string | null, guest: [l.guest_first, l.guest_last].filter(Boolean).join(' ') || null, arrival: l.arrival as string | null })),
      suggestions: p.transaction_id ? [] : payoutCandidates(p, false).map((c) => ({ ...txRow(c), exact: toCents(c.amount) === toCents(p.amount) })).sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 8),
    }));

    const deposits = (
      db
        .prepare(
          `SELECT t.*, a.name AS account, d.source, d.purpose, d.amount AS share, ${BALANCE} AS balance FROM stay_deposits d
           JOIN bank_transactions t ON t.id = d.transaction_id JOIN bank_accounts a ON a.id = t.account_id WHERE d.stay_id = ? ORDER BY t.posted, d.id`
        )
        .all(id) as Row[]
    ).map((t) => ({ ...txRow(t), source: t.source as string, purpose: t.purpose as 'stay' | 'security' | 'refund', share: t.share as number, balance: round(t.balance) }));

    // Deposits that might be this stay's, when Hospitable has no payout for it: those
    // with something left, offered for what's still due.
    const due = round(depositAmount(row) - stay.received);
    let suggestions: (ReturnType<typeof txRow> & { exact: boolean; balance: number })[] = [];
    if (!payouts.length && !stay.paid && stay.status === 'accepted') {
      const target = due > 0 ? toCents(due) : null;
      suggestions = stayCandidates(row, false)
        .map((c) => ({ ...txRow(c), balance: round(c.balance), exact: target !== null && toCents(c.balance) === target }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || Math.abs(dayNumber(a.posted) - dayNumber(stay.arrival)) - Math.abs(dayNumber(b.posted) - dayNumber(stay.arrival)))
        .slice(0, 10);
    }
    const held = round(stay.security - stay.refunded);
    return { stay, lines, payouts, deposits, suggestions, due: Math.max(0, due), refundSuggestions: held > 0.005 ? refundCandidates(row, held) : [], conflicts: conflictsFor([`stay:${id}`, ...payouts.map((p) => `payout:${p.id}`)]) };
  }

  // What a conflict's choices are, in words: each way the deposit could be made up.
  function describe(subject: string) {
    const kind = subject.slice(0, subject.indexOf(':'));
    const id = subject.slice(subject.indexOf(':') + 1);
    if (kind === 'stay') {
      const s = db.prepare('SELECT s.*, p.name AS property_name FROM stays s LEFT JOIN stay_properties p ON p.id = s.property_id WHERE s.id = ?').get(id) as Row | undefined;
      if (!s) return null;
      return { subject, kind, id, label: [s.guest_first, s.guest_last].filter(Boolean).join(' ') || 'Guest', date: s.arrival as string, detail: (s.property_name as string | null) || '', amount: s.payout as number, stayIds: [s.id as string] };
    }
    const p = db.prepare('SELECT * FROM stay_payouts WHERE id = ?').get(id) as Row | undefined;
    if (!p) return null;
    const guests = db.prepare('SELECT l.stay_id, s.guest_first, s.guest_last FROM stay_payout_lines l LEFT JOIN stays s ON s.id = l.stay_id WHERE l.payout_id = ? ORDER BY s.arrival').all(id) as Row[];
    return {
      subject,
      kind,
      id,
      label: 'Airbnb payout',
      date: p.paid_on as string,
      detail: guests.map((g) => [g.guest_first, g.guest_last].filter(Boolean).join(' ')).filter(Boolean).join(', '),
      amount: p.amount as number,
      stayIds: guests.map((g) => g.stay_id as string).filter(Boolean),
    };
  }

  function conflictsFor(subjects: string[]) {
    if (!subjects.length) return [];
    const rows = db
      .prepare(
        `SELECT DISTINCT c.transaction_id, c.options, t.posted, t.amount, t.payee, t.description, a.name AS account FROM stay_conflicts c
         JOIN bank_transactions t ON t.id = c.transaction_id JOIN bank_accounts a ON a.id = t.account_id
         WHERE c.subject IN (${subjects.map(() => '?').join(', ')}) ORDER BY t.posted`
      )
      .all(...subjects) as Row[];
    return rows.map((r) => ({
      deposit: { id: r.transaction_id as number, posted: r.posted as string, amount: r.amount as number, payee: (r.payee || r.description) as string, account: r.account as string },
      options: (JSON.parse(r.options) as string[][]).map((group) => {
        const items = group.map(describe).filter((x): x is NonNullable<ReturnType<typeof describe>> => Boolean(x));
        return { subjects: group, items, total: round(items.reduce((n, i) => n + i.amount, 0)) };
      }),
    }));
  }

  function conflictList() {
    const subjects = (db.prepare('SELECT DISTINCT subject FROM stay_conflicts').all() as Row[]).map((r) => r.subject as string);
    return conflictsFor(subjects);
  }

  // The user picks the way a deposit was made up.
  function resolve(transactionId: number, subjects: string[]) {
    if (!bank.transactionById(transactionId)) throw new Error('That transaction was not found.');
    const row = db.prepare('SELECT options FROM stay_conflicts WHERE transaction_id = ? LIMIT 1').get(transactionId) as Row | undefined;
    const allowed = row ? (JSON.parse(row.options) as string[][]).some((g) => g.length === subjects.length && g.every((s) => subjects.includes(s))) : false;
    if (!allowed) throw new Error('That choice is no longer open. Reload the page.');
    db.exec('BEGIN');
    try {
      for (const subject of subjects) {
        const id = subject.slice(subject.indexOf(':') + 1);
        if (subject.startsWith('payout:')) db.prepare(`UPDATE stay_payouts SET transaction_id = ?, match_source = 'user' WHERE id = ?`).run(transactionId, id);
        else {
          const s = db.prepare('SELECT * FROM stays WHERE id = ?').get(id) as Row | undefined;
          if (s) db.prepare(`INSERT INTO stay_deposits (stay_id, transaction_id, purpose, amount, source, created_at) VALUES (?, ?, 'stay', ?, 'user', ?) ON CONFLICT DO UPDATE SET source = 'user'`).run(id, transactionId, depositAmount(s), now());
        }
      }
      db.prepare('DELETE FROM stay_conflicts WHERE transaction_id = ?').run(transactionId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    match();
  }

  /* ---------- Airbnb week by week ---------- */

  // The Monday a date's week starts on. Day 0 (1970-01-01) was a Thursday.
  const weekOf = (date: string) => {
    const n = dayNumber(date);
    return new Date((n - ((n + 3) % 7)) * DAY_MS).toISOString().slice(0, 10);
  };

  // Each week's Airbnb payouts (or, before Hospitable's payout history, each stay's
  // expected payout) against the deposits linked to them, plus Airbnb deposits that
  // nothing claims.
  function airbnbWeeks(year: string) {
    const start = bankStart();
    const conflicts = new Set((db.prepare('SELECT subject FROM stay_conflicts').all() as Row[]).map((r) => r.subject as string));
    const statusOf = (date: string, linked: boolean, subject: string) =>
      linked ? 'paid' : conflicts.has(subject) ? 'conflict' : start && date < start ? 'nobank' : shift(date, GRACE_DAYS) >= today() ? 'due' : 'missing';
    type Item = { kind: 'payout' | 'stay'; id: string; date: string; amount: number; deposit: { id: number; posted: string; amount: number } | null; stays: { id: string | null; guest: string; amount: number }[]; status: string };
    const items: Item[] = [];

    const payouts = db
      .prepare(`SELECT p.*, t.posted, t.amount AS tx_amount FROM stay_payouts p LEFT JOIN bank_transactions t ON t.id = p.transaction_id WHERE substr(p.paid_on, 1, 4) = ? ORDER BY p.paid_on`)
      .all(year) as Row[];
    const lines = db.prepare('SELECT l.amount, l.type, l.stay_id, s.guest_first, s.guest_last FROM stay_payout_lines l LEFT JOIN stays s ON s.id = l.stay_id WHERE l.payout_id = ? ORDER BY s.arrival, l.id');
    for (const p of payouts) {
      items.push({
        kind: 'payout',
        id: p.id,
        date: p.paid_on,
        amount: p.amount,
        deposit: p.transaction_id ? { id: p.transaction_id, posted: p.posted, amount: p.tx_amount } : null,
        stays: (lines.all(p.id) as Row[]).map((l) => ({ id: l.stay_id ?? null, guest: [l.guest_first, l.guest_last].filter(Boolean).join(' ') || l.type, amount: l.amount })),
        status: statusOf(p.paid_on, Boolean(p.transaction_id), `payout:${p.id}`),
      });
    }
    // Airbnb stays from before the payout history: due the day after check-in.
    const earliest = (db.prepare('SELECT MIN(paid_on) AS d FROM stay_payouts').get() as Row).d as string | null;
    const older = db
      .prepare(
        `SELECT s.*, (SELECT t.id || '|' || t.posted || '|' || t.amount FROM stay_deposits d JOIN bank_transactions t ON t.id = d.transaction_id WHERE d.stay_id = s.id LIMIT 1) AS dep
         FROM stays s WHERE s.platform = 'airbnb' AND s.status = 'accepted' AND s.payout > 0
           AND NOT EXISTS (SELECT 1 FROM stay_payout_lines l WHERE l.stay_id = s.id)
           AND (? IS NULL OR s.arrival < ?) AND substr(date(s.arrival, '+1 day'), 1, 4) = ?`
      )
      .all(earliest, earliest, year) as Row[];
    for (const s of older) {
      const date = shift(s.arrival, 1);
      const [depId, depPosted, depAmount] = s.dep ? String(s.dep).split('|') : [];
      const guest = [s.guest_first, s.guest_last].filter(Boolean).join(' ') || 'Guest';
      items.push({
        kind: 'stay',
        id: s.id,
        date,
        amount: s.payout,
        deposit: s.dep ? { id: Number(depId), posted: depPosted, amount: Number(depAmount) } : null,
        stays: [{ id: s.id, guest, amount: s.payout }],
        status: statusOf(date, Boolean(s.dep), `stay:${s.id}`),
      });
    }
    // Airbnb deposits that nothing claims.
    const inConflict = db.prepare('SELECT 1 FROM stay_conflicts WHERE transaction_id = ?');
    const extras = (
      db
        .prepare(`SELECT t.id, t.posted, t.amount, t.description, t.payee FROM bank_transactions t WHERE t.amount > 0 AND t.kind = 'normal' AND substr(t.posted, 1, 4) = ? AND ${FREE} ORDER BY t.posted`)
        .all(year) as Row[]
    )
      .filter((r) => incomeSource(`${r.description} ${r.payee || ''}`) === 'airbnb')
      .map((r) => ({ id: r.id as number, posted: r.posted as string, amount: r.amount as number, conflict: Boolean(inConflict.get(r.id)) }));

    const weeks = new Map<string, { week: string; items: Item[]; extras: typeof extras }>();
    const weekFor = (key: string) => {
      if (!weeks.has(key)) weeks.set(key, { week: key, items: [], extras: [] });
      return weeks.get(key)!;
    };
    for (const i of items) weekFor(weekOf(i.date)).items.push(i);
    for (const e of extras) weekFor(weekOf(e.posted)).extras.push(e);

    // The week's state is its most pressing item's.
    const order = ['conflict', 'missing', 'extra', 'due', 'nobank', 'paid'];
    const out = [...weeks.values()]
      .sort((a, b) => b.week.localeCompare(a.week))
      .map((w) => {
        w.items.sort((a, b) => a.date.localeCompare(b.date));
        const expected = round(w.items.reduce((n, i) => n + i.amount, 0));
        const matched = round(w.items.filter((i) => i.deposit).reduce((n, i) => n + i.amount, 0));
        const unclaimed = round(w.extras.reduce((n, e) => n + e.amount, 0));
        const states = new Set<string>(w.items.map((i) => i.status));
        if (w.extras.some((e) => e.conflict)) states.add('conflict');
        else if (w.extras.length) states.add('extra');
        const status = order.find((s) => states.has(s)) || 'paid';
        return { week: w.week, expected, matched, unmatched: round(expected - matched), unclaimed, status, items: w.items, extras: w.extras };
      });
    const totals = {
      expected: round(out.reduce((n, w) => n + w.expected, 0)),
      matched: round(out.reduce((n, w) => n + w.matched, 0)),
      unclaimed: round(out.reduce((n, w) => n + w.unclaimed, 0)),
      weeks: out.length,
      weeksToCheck: out.filter((w) => w.status === 'conflict' || w.status === 'missing' || w.status === 'extra').length,
      bankStart: start,
    };
    return { weeks: out, totals };
  }

  /* ---------- Changes by the user ---------- */

  const txExists = (id: number) => {
    if (!bank.transactionById(id)) throw new Error('That transaction was not found.');
  };

  type Purpose = 'stay' | 'security' | 'refund';

  // What's left of a transaction for stays (see BALANCE).
  function balanceOf(txId: number) {
    const row = db.prepare(`SELECT ${BALANCE} AS b FROM bank_transactions t WHERE t.id = ?`).get(txId) as Row | undefined;
    return round(Number(row?.b) || 0);
  }

  // Payments out after a stay that could be its security deposit coming back.
  function refundCandidates(stay: Row, held: number) {
    return (
      db
        .prepare(
          `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.name AS account, ${BALANCE} AS balance FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
           WHERE t.amount < 0 AND t.kind = 'normal' AND t.posted BETWEEN ? AND ? AND ${BALANCE} > 0.005
             AND NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.transaction_id = t.id AND d.stay_id = ?)
             AND NOT EXISTS (SELECT 1 FROM stay_link_rejections j WHERE j.subject = ? AND j.transaction_id = t.id)
           ORDER BY t.posted`
        )
        .all(shift(stay.departure, -3), shift(stay.departure, 90), stay.id, `refund:${stay.id}`) as Row[]
    )
      .map((r) => ({ ...txRow(r), balance: round(r.balance), exact: toCents(r.balance) === toCents(held), text: `${r.payee || ''} ${r.description || ''}` }))
      // The whole deposit back, or part of it (some kept for damage) by cheque, Zelle and the like; not ordinary bills.
      .filter((r) => r.balance <= held + 0.005 && (r.exact || /\b(check|chk|cheque|zelle|venmo|paypal|cash ?app|transfer|refund)\b/i.test(r.text)))
      .map(({ text: _text, ...r }) => r)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.posted.localeCompare(b.posted))
      .slice(0, 10);
  }

  // Links part or all of a transaction to a stay: a payment for the stay, a security
  // deposit held, or a refund paid back. With no amount, it takes what's still due (or
  // held), up to what's left of the transaction.
  function linkStay(stayId: string, txId: number, options: { amount?: number | null; purpose?: Purpose } = {}) {
    const tx = bank.transactionById(txId) as Row | null;
    if (!tx) throw new Error('That transaction was not found.');
    const stay = db.prepare(`${SELECT} WHERE s.id = ?`).get(stayId) as Row | undefined;
    if (!stay) throw new Error('That stay was not found.');
    const purpose = options.purpose || 'stay';
    if (db.prepare('SELECT 1 FROM stay_payouts WHERE transaction_id = ?').get(txId)) throw new Error('That deposit is already an Airbnb payout.');
    if (purpose === 'refund' ? tx.amount >= 0 : tx.amount <= 0) throw new Error(purpose === 'refund' ? 'A refund is money paid out.' : 'Only money coming in can pay for a stay.');
    const existing = db.prepare('SELECT amount FROM stay_deposits WHERE stay_id = ? AND transaction_id = ? AND purpose = ?').get(stayId, txId, purpose) as Row | undefined;
    const left = round(balanceOf(txId) + (Number(existing?.amount) || 0));
    if (left <= 0.005) throw new Error('Nothing is left of that transaction to link.');
    const wanted =
      purpose === 'stay' ? round(depositAmount(stay) - Number(stay.received) + (Number(existing?.amount) || 0)) : purpose === 'security' ? left : round(Number(stay.security) - Number(stay.refunded) + (Number(existing?.amount) || 0));
    const amount = round(options.amount ?? (wanted > 0.005 ? Math.min(wanted, left) : left));
    if (!(amount > 0)) throw new Error('The amount must be more than zero.');
    if (amount > left + 0.005) throw new Error(`Only ${left.toFixed(2)} is left of that transaction.`);
    db.prepare('DELETE FROM stay_link_rejections WHERE subject IN (?, ?) AND transaction_id = ?').run(`stay:${stayId}`, `refund:${stayId}`, txId);
    db.prepare(
      `INSERT INTO stay_deposits (stay_id, transaction_id, purpose, amount, source, created_at) VALUES (?, ?, ?, ?, 'user', ?)
       ON CONFLICT (stay_id, transaction_id, purpose) DO UPDATE SET amount = excluded.amount, source = 'user'`
    ).run(stayId, txId, purpose, amount, now());
  }

  // Unlinked by hand: not matched to that deposit again.
  function unlinkStay(stayId: string, txId: number, purpose?: Purpose) {
    const removed = (
      purpose
        ? db.prepare('DELETE FROM stay_deposits WHERE stay_id = ? AND transaction_id = ? AND purpose = ?').run(stayId, txId, purpose)
        : db.prepare('DELETE FROM stay_deposits WHERE stay_id = ? AND transaction_id = ?').run(stayId, txId)
    ).changes > 0;
    // Once nothing of it is linked to this stay, it isn't offered to the stay again.
    if (removed && !db.prepare('SELECT 1 FROM stay_deposits WHERE stay_id = ? AND transaction_id = ?').get(stayId, txId)) {
      const tx = bank.transactionById(txId) as Row | null;
      db.prepare('INSERT OR IGNORE INTO stay_link_rejections (subject, transaction_id) VALUES (?, ?)').run(`${tx && tx.amount < 0 ? 'refund' : 'stay'}:${stayId}`, txId);
    }
    return removed;
  }

  function linkPayout(payoutId: string, txId: number) {
    txExists(txId);
    if (!db.prepare('SELECT 1 FROM stay_payouts WHERE id = ?').get(payoutId)) throw new Error('That payout was not found.');
    if (db.prepare('SELECT 1 FROM stay_deposits WHERE transaction_id = ?').get(txId)) throw new Error('That deposit is already linked to a stay.');
    db.prepare('DELETE FROM stay_link_rejections WHERE subject = ? AND transaction_id = ?').run(`payout:${payoutId}`, txId);
    db.prepare(`UPDATE stay_payouts SET transaction_id = ?, match_source = 'user' WHERE id = ?`).run(txId, payoutId);
  }

  function unlinkPayout(payoutId: string) {
    const row = db.prepare('SELECT transaction_id FROM stay_payouts WHERE id = ?').get(payoutId) as Row | undefined;
    if (!row?.transaction_id) return false;
    db.prepare('INSERT OR IGNORE INTO stay_link_rejections (subject, transaction_id) VALUES (?, ?)').run(`payout:${payoutId}`, row.transaction_id);
    db.prepare(`UPDATE stay_payouts SET transaction_id = NULL, match_source = NULL WHERE id = ?`).run(payoutId);
    return true;
  }

  function setNote(stayId: string, note: string | null) {
    return db.prepare('UPDATE stays SET note = ? WHERE id = ?').run(note?.trim().slice(0, 2000) || null, stayId).changes > 0;
  }

  return { status, connect, disconnect, sync, due, match, list, options, get, conflictList, resolve, airbnbWeeks, linkStay, unlinkStay, linkPayout, unlinkPayout, setNote };
}

export type StayService = ReturnType<typeof stayService>;

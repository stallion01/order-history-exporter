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
export const STAY_VIEWS = ['all', 'upcoming', 'unpaid', 'cancelled'] as const;
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
          const amount = cents(t.paid_out_amount?.amount);
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

  function payoutCandidates(payout: Row, exactOnly = true) {
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.name AS account, a.last4 FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount > 0 AND t.kind = 'normal' AND t.posted BETWEEN ? AND ?
           ${exactOnly ? 'AND CAST(ROUND(t.amount * 100) AS INTEGER) = ?' : ''}
           AND (${FREE} OR t.id = ?)
           AND NOT EXISTS (SELECT 1 FROM stay_link_rejections j WHERE j.subject = ? AND j.transaction_id = t.id)
         ORDER BY t.posted`
      )
      .all(shift(payout.paid_on, -2), shift(payout.paid_on, exactOnly ? 7 : 14), ...(exactOnly ? [toCents(payout.amount)] : []), payout.transaction_id ?? -1, `payout:${payout.id}`) as Row[];
    const last4 = last4Of(payout.bank_account);
    const sameAccount = last4 ? rows.filter((r) => r.last4 === last4) : [];
    return sameAccount.length ? sameAccount : rows;
  }

  function stayCandidates(stay: Row, exactOnly = true) {
    const [from, to] = depositWindow(stay);
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, a.name AS account FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount > 0 AND t.kind = 'normal' AND t.posted BETWEEN ? AND ?
           ${exactOnly ? 'AND CAST(ROUND(t.amount * 100) AS INTEGER) = ?' : ''}
           AND (${FREE} OR t.id IN (SELECT transaction_id FROM stay_deposits WHERE stay_id = ?))
           AND NOT EXISTS (SELECT 1 FROM stay_link_rejections j WHERE j.subject = ? AND j.transaction_id = t.id)
         ORDER BY t.posted`
      )
      .all(from, to, ...(exactOnly ? [toCents(stay.payout)] : []), stay.id, `stay:${stay.id}`) as Row[];
    // A deposit that names another platform isn't this stay's.
    const mine = platformGroup(stay.platform);
    return rows.filter((r) => {
      const named = incomeSource(`${r.description} ${r.payee || ''}`);
      return named === 'other' || named === mine;
    });
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
           AND (s.platform != 'airbnb' OR ? IS NULL OR s.arrival < ?)`
      )
      .all(earliest, earliest) as Row[];
  }

  // Links what is clear: one deposit fits, and no other payout or stay wants it.
  function match() {
    let linked = 0;
    for (let pass = 0; pass < 3; pass++) {
      let changed = 0;
      const want = new Map<number, string[]>();
      const plans: { kind: 'payout' | 'stay'; id: string; tx: number }[] = [];
      for (const p of db.prepare(`SELECT * FROM stay_payouts WHERE transaction_id IS NULL`).all() as Row[]) {
        const list = payoutCandidates(p);
        for (const c of list) want.set(c.id, [...(want.get(c.id) || []), `payout:${p.id}`]);
        if (list.length === 1) plans.push({ kind: 'payout', id: p.id, tx: list[0].id });
      }
      for (const s of staysWithoutPayouts()) {
        const list = stayCandidates(s);
        for (const c of list) want.set(c.id, [...(want.get(c.id) || []), `stay:${s.id}`]);
        if (list.length === 1) plans.push({ kind: 'stay', id: s.id, tx: list[0].id });
      }
      for (const plan of plans) {
        if ((want.get(plan.tx) || []).length !== 1) continue;
        if (plan.kind === 'payout') db.prepare(`UPDATE stay_payouts SET transaction_id = ?, match_source = 'auto' WHERE id = ? AND transaction_id IS NULL`).run(plan.tx, plan.id);
        else db.prepare(`INSERT OR IGNORE INTO stay_deposits (stay_id, transaction_id, source, created_at) VALUES (?, ?, 'auto', ?)`).run(plan.id, plan.tx, now());
        changed++;
      }
      linked += changed;
      if (!changed) break;
    }
    return linked;
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
    if (view === 'unpaid') {
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

  const PAID = `EXISTS (SELECT 1 FROM stay_deposits d WHERE d.stay_id = s.id) OR EXISTS (SELECT 1 FROM stay_payout_lines l JOIN stay_payouts p ON p.id = l.payout_id WHERE l.stay_id = s.id AND p.transaction_id IS NOT NULL)`;

  const toStay = (r: Row) => {
    const paid = Boolean(r.paid);
    const started = r.arrival <= today();
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
      note: r.note as string | null,
      paid,
      // Money expected but not seen: after arrival, with nothing linked.
      payment: r.status !== 'accepted' ? 'none' : paid ? 'paid' : !r.payout ? 'none' : started ? 'missing' : 'upcoming',
      depositDate: (r.deposit_date as string | null) ?? null,
    };
  };

  const SELECT = `SELECT s.*, p.name AS property_name, (${PAID}) AS paid,
      COALESCE((SELECT MIN(t.posted) FROM stay_deposits d JOIN bank_transactions t ON t.id = d.transaction_id WHERE d.stay_id = s.id),
               (SELECT MIN(t.posted) FROM stay_payout_lines l JOIN stay_payouts po ON po.id = l.payout_id JOIN bank_transactions t ON t.id = po.transaction_id WHERE l.stay_id = s.id)) AS deposit_date
    FROM stays s LEFT JOIN stay_properties p ON p.id = s.property_id`;

  function list(filters: StayFilters) {
    const { sql, params } = whereFor(filters);
    const asc = filters.view === 'upcoming';
    const rows = db.prepare(`${SELECT} ${sql} ORDER BY s.arrival ${asc ? 'ASC' : 'DESC'}, s.id LIMIT 2000`).all(...params) as Row[];
    const stays = rows.map(toStay);

    // Totals for what's listed, and per property.
    const accepted = stays.filter((s) => s.status === 'accepted');
    const totals = {
      stays: accepted.length,
      nights: accepted.reduce((n, s) => n + (s.nights || 0), 0),
      payout: round(accepted.reduce((n, s) => n + (s.payout || 0), 0)),
      paid: round(accepted.filter((s) => s.paid).reduce((n, s) => n + (s.payout || 0), 0)),
      missing: round(accepted.filter((s) => s.payment === 'missing').reduce((n, s) => n + (s.payout || 0), 0)),
      missingCount: accepted.filter((s) => s.payment === 'missing').length,
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
    const stay = toStay(row);
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
          `SELECT t.*, a.name AS account, d.source FROM stay_deposits d JOIN bank_transactions t ON t.id = d.transaction_id JOIN bank_accounts a ON a.id = t.account_id WHERE d.stay_id = ? ORDER BY t.posted`
        )
        .all(id) as Row[]
    ).map((t) => ({ ...txRow(t), source: t.source as string }));

    // Deposits that might be this stay's, when Hospitable has no payout for it.
    let suggestions: (ReturnType<typeof txRow> & { exact: boolean })[] = [];
    if (!payouts.length && !deposits.length && stay.status === 'accepted') {
      const target = stay.payout ? toCents(stay.payout) : null;
      suggestions = stayCandidates(row, false)
        .map((c) => ({ ...txRow(c), exact: target !== null && toCents(c.amount) === target }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || Math.abs(dayNumber(a.posted) - dayNumber(stay.arrival)) - Math.abs(dayNumber(b.posted) - dayNumber(stay.arrival)))
        .slice(0, 10);
    }
    return { stay, lines, payouts, deposits, suggestions };
  }

  /* ---------- Changes by the user ---------- */

  const txExists = (id: number) => {
    if (!bank.transactionById(id)) throw new Error('That transaction was not found.');
  };
  const claimedElsewhere = (txId: number, except: { stay?: string; payout?: string }) =>
    Boolean(
      db.prepare('SELECT 1 FROM stay_payouts WHERE transaction_id = ? AND id != ?').get(txId, except.payout ?? '') ||
        db.prepare('SELECT 1 FROM stay_deposits WHERE transaction_id = ? AND stay_id != ?').get(txId, except.stay ?? '')
    );

  function linkStay(stayId: string, txId: number) {
    txExists(txId);
    if (!db.prepare('SELECT 1 FROM stays WHERE id = ?').get(stayId)) throw new Error('That stay was not found.');
    if (db.prepare('SELECT 1 FROM stay_payouts WHERE transaction_id = ?').get(txId)) throw new Error('That deposit is already an Airbnb payout.');
    db.prepare('DELETE FROM stay_link_rejections WHERE subject = ? AND transaction_id = ?').run(`stay:${stayId}`, txId);
    db.prepare(`INSERT INTO stay_deposits (stay_id, transaction_id, source, created_at) VALUES (?, ?, 'user', ?) ON CONFLICT DO UPDATE SET source = 'user'`).run(stayId, txId, now());
  }

  // Unlinked by hand: not matched to that deposit again.
  function unlinkStay(stayId: string, txId: number) {
    const removed = db.prepare('DELETE FROM stay_deposits WHERE stay_id = ? AND transaction_id = ?').run(stayId, txId).changes > 0;
    db.prepare('INSERT OR IGNORE INTO stay_link_rejections (subject, transaction_id) VALUES (?, ?)').run(`stay:${stayId}`, txId);
    return removed;
  }

  function linkPayout(payoutId: string, txId: number) {
    txExists(txId);
    if (!db.prepare('SELECT 1 FROM stay_payouts WHERE id = ?').get(payoutId)) throw new Error('That payout was not found.');
    if (claimedElsewhere(txId, { payout: payoutId })) throw new Error('That deposit is already linked to something else.');
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

  return { status, connect, disconnect, sync, due, match, list, options, get, linkStay, unlinkStay, linkPayout, unlinkPayout, setNote };
}

export type StayService = ReturnType<typeof stayService>;

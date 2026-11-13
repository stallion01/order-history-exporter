// Leases: mid-term tenancies, the rent expected each month, and every payment (rent,
// a security deposit held, paid back, or kept towards rent).
//
// Each payment is in the ledger. One that arrived outside the bank (Zelle or PayPal to
// a personal account, say) becomes transactions of its own in a "Rent received outside
// the bank" account; one that reached a connected account links to its transaction
// instead. Rent is Rental Income. Deposits and their refunds are Security Deposits and
// typed Ignored: money held for the tenant, not income or spending.
//
// A lease belongs to one business (its property's, unless chosen), and each business
// has its own "outside the bank" account, so one business's rent never lands in another's.
import type { DatabaseSync } from 'node:sqlite';
import type { BankStore } from '../bank/store';
import { toCents } from '../bank/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const PAYMENT_PURPOSES = ['rent', 'deposit', 'refund', 'applied'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
export const RENTAL_INCOME = 'Rental Income';
export const SECURITY_DEPOSITS = 'Security Deposits';
const ACCOUNT_SETTING = 'lease.accountId';
const ACCOUNT_NAME = 'Rent received outside the bank';
const MONTH = /^\d{4}-\d{2}$/;

export interface LeaseInput {
  ref?: string | null;
  entityId?: number | null;
  propertyId?: string | null;
  unit: string;
  tenant: string;
  phone?: string | null;
  email?: string | null;
  start: string;
  end?: string | null;
  rent?: number | null;
  deposit?: number | null;
  channel?: string | null;
  ended?: boolean;
  note?: string | null;
}
export interface PaymentInput {
  date: string;
  amount: number; // always positive; the purpose says which way it went
  purpose: PaymentPurpose;
  channel?: string | null;
  note?: string | null;
  verified?: boolean;
  // A transaction already in the ledger (rent that reached the bank, say), instead of
  // adding one.
  transactionId?: number | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export function leaseService({ db, bank }: { db: DatabaseSync; bank: BankStore }) {
  const now = () => new Date().toISOString();

  /* ---------- Where payments go in the ledger ---------- */

  function ensureCategory() {
    db.prepare(
      `INSERT OR IGNORE INTO categories (name, schedule_c, schedule_e, position, expense_class)
       VALUES (?, NULL, NULL, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories), 'opex')`
    ).run(SECURITY_DEPOSITS);
  }

  // The business's own account for rent received outside the bank. The first one made
  // (before businesses were kept apart) is taken over by the business it was given to.
  function accountId(entity: number | null) {
    const key = entity ? `${ACCOUNT_SETTING}.${entity}` : ACCOUNT_SETTING;
    let id = Number(bank.getSetting(key)) || null;
    if (id && bank.account(id)) return id;
    const first = Number(bank.getSetting(ACCOUNT_SETTING)) || null;
    if (entity && first && bank.account(first)?.entityId === entity) {
      bank.setSetting(key, String(first));
      return first;
    }
    if (!entity && first && bank.account(first)) return first;
    const name = entity ? (db.prepare('SELECT name FROM entities WHERE id = ?').get(entity) as Row | undefined)?.name : null;
    id = bank.createAccount({ name: name ? `${ACCOUNT_NAME} (${name})`.slice(0, 100) : ACCOUNT_NAME, kind: 'other', owner: 'business' });
    if (entity) bank.updateAccount(id, { entityId: entity });
    bank.setSetting(key, String(id));
    return id;
  }

  // What a payment puts in the ledger: rent in, a deposit in or out, or (kept towards
  // rent) both rent in and the deposit out, which together move no money.
  function ledgerLines(lease: Row, p: { purpose: PaymentPurpose; amount: number }) {
    const who = `${lease.unit} · ${lease.tenant}`;
    const rent = { amount: p.amount, description: `Lease rent · ${who}`, category: RENTAL_INCOME, kind: 'normal' as const };
    switch (p.purpose) {
      case 'rent':
        return [rent];
      case 'deposit':
        return [{ amount: p.amount, description: `Security deposit · ${who}`, category: SECURITY_DEPOSITS, kind: 'ignored' as const }];
      case 'refund':
        return [{ amount: -p.amount, description: `Security deposit returned · ${who}`, category: SECURITY_DEPOSITS, kind: 'ignored' as const }];
      case 'applied':
        return [
          { ...rent, description: `Lease rent from deposit · ${who}` },
          { amount: -p.amount, description: `Security deposit kept for rent · ${who}`, category: SECURITY_DEPOSITS, kind: 'ignored' as const },
        ];
    }
  }

  const ownTransactions = (paymentId: number) =>
    (db.prepare(`SELECT transaction_id FROM bank_tx_sources WHERE source = 'lease' AND external_id LIKE ?`).all(`lease-${paymentId}-%`) as Row[]).map((r) => r.transaction_id as number);

  function removeLedger(paymentId: number) {
    const ids = ownTransactions(paymentId);
    if (ids.length) db.prepare(`DELETE FROM bank_transactions WHERE id IN (${ids.map(Number).join(',')})`).run();
  }

  function writeLedger(paymentId: number) {
    const p = db.prepare('SELECT * FROM lease_payments WHERE id = ?').get(paymentId) as Row;
    const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(p.lease_id) as Row;
    removeLedger(paymentId);
    const lines = ledgerLines(lease, { purpose: p.purpose, amount: p.amount });
    const note = [p.note, p.verified ? null : 'Date or amount not confirmed', p.channel ? `Paid by ${p.channel}` : null].filter(Boolean).join(' · ') || null;
    if (p.transaction_id) {
      // Already in the ledger: give it the right category and type.
      const [line] = lines;
      bank.updateTransactions([p.transaction_id], { category: line.category, status: 'business', kind: line.kind === 'ignored' ? 'ignored' : null, ...(note ? { note } : {}) });
      return;
    }
    ensureCategory();
    const account = accountId((lease.entity_id as number | null) ?? null);
    const stamp = now();
    const insert = db.prepare(
      'INSERT INTO bank_transactions (account_id, posted, amount, description, payee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const source = db.prepare(`INSERT INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, 'lease', ?, ?)`);
    const ids: number[] = [];
    lines.forEach((line, n) => {
      const id = Number(insert.run(account, p.paid_on, cents(line.amount), line.description, lease.tenant, stamp, stamp).lastInsertRowid);
      source.run(account, `lease-${paymentId}-${n}`, id);
      ids.push(id);
      bank.updateTransactions([id], { category: line.category, status: 'business', kind: line.kind === 'ignored' ? 'ignored' : null, note });
    });
  }

  /* ---------- Reading ---------- */

  function statusOf(lease: Row) {
    const day = today();
    if (lease.ended || (lease.end_date && lease.end_date < day)) return 'ended';
    if (lease.start_date > day) return 'upcoming';
    return 'active';
  }

  // Rent expected, collected and still owed, and the deposit held.
  function totals(lease: Row, months: Row[], payments: Row[]) {
    const month = today().slice(0, 7);
    const sum = (rows: Row[], pick: (r: Row) => number) => cents(rows.reduce((t, r) => t + pick(r), 0));
    const scheduled = sum(months, (m) => m.amount);
    const dueSoFar = sum(months.filter((m) => m.month <= month), (m) => m.amount);
    const collected = sum(payments.filter((p) => p.purpose === 'rent' || p.purpose === 'applied'), (p) => p.amount);
    const depositIn = sum(payments.filter((p) => p.purpose === 'deposit'), (p) => p.amount);
    const depositOut = sum(payments.filter((p) => p.purpose === 'refund' || p.purpose === 'applied'), (p) => p.amount);
    return {
      scheduled,
      dueSoFar,
      collected,
      owed: Math.max(0, cents(dueSoFar - collected)),
      depositHeld: cents(depositIn - depositOut),
      unverified: payments.filter((p) => !p.verified).length,
    };
  }

  const toLease = (row: Row, months: Row[], payments: Row[]) => ({
    id: row.id as number,
    ref: row.ref as string | null,
    entityId: (row.entity_id as number | null) ?? null,
    propertyId: row.property_id as string | null,
    unit: row.unit as string,
    tenant: row.tenant as string,
    phone: row.phone as string | null,
    email: row.email as string | null,
    start: row.start_date as string,
    end: row.end_date as string | null,
    rent: row.rent as number | null,
    deposit: row.deposit as number | null,
    channel: row.channel as string | null,
    ended: Boolean(row.ended),
    note: row.note as string | null,
    status: statusOf(row),
    ...totals(row, months, payments),
  });

  const monthsOf = (id: number) => db.prepare('SELECT month, amount, note FROM lease_months WHERE lease_id = ? ORDER BY month').all(id) as Row[];
  const paymentsOf = (id: number) => db.prepare('SELECT * FROM lease_payments WHERE lease_id = ? ORDER BY paid_on, id').all(id) as Row[];

  // All leases, or one business's.
  function list(entity: number | null = null) {
    const rows = db.prepare(`SELECT * FROM leases ${entity ? 'WHERE entity_id = ?' : ''} ORDER BY start_date DESC, id DESC`).all(...(entity ? [entity] : [])) as Row[];
    const leases = rows.map((row) => toLease(row, monthsOf(row.id), paymentsOf(row.id)));
    const sum = (pick: (l: (typeof leases)[number]) => number) => cents(leases.reduce((t, l) => t + pick(l), 0));
    const year = today().slice(0, 4);
    const rentThisYear = (
      db
        .prepare(
          `SELECT COALESCE(SUM(p.amount), 0) AS n FROM lease_payments p JOIN leases l ON l.id = p.lease_id WHERE p.purpose IN ('rent', 'applied') AND p.paid_on LIKE ? ${entity ? 'AND l.entity_id = ?' : ''}`
        )
        .get(`${year}-%`, ...(entity ? [entity] : [])) as Row
    ).n as number;
    return {
      leases,
      totals: {
        active: leases.filter((l) => l.status === 'active').length,
        rentThisYear: cents(rentThisYear),
        owed: sum((l) => l.owed),
        depositsHeld: sum((l) => l.depositHeld),
      },
      units: (db.prepare('SELECT id, name, entity_id FROM stay_properties ORDER BY name').all() as Row[]).map((r) => ({ id: r.id as string, name: r.name as string, entityId: (r.entity_id as number | null) ?? null })),
    };
  }

  function get(id: number) {
    const row = db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const months = monthsOf(id);
    const payments = paymentsOf(id);
    // Each month's rent against what was collected, oldest first: payments fill the
    // months in order, so a month is paid once enough rent has come in.
    let pot = payments.filter((p) => p.purpose === 'rent' || p.purpose === 'applied').reduce((t, p) => t + toCents(p.amount), 0);
    const month = today().slice(0, 7);
    const schedule = months.map((m) => {
      const want = toCents(m.amount);
      const paid = Math.min(pot, want);
      pot -= paid;
      return { month: m.month, amount: m.amount, note: m.note, paid: paid / 100, state: paid >= want ? 'paid' : m.month > month ? 'upcoming' : paid > 0 ? 'partial' : 'due' };
    });
    return {
      lease: toLease(row, months, payments),
      schedule,
      payments: payments.map((p) => {
        const own = ownTransactions(p.id);
        return {
          id: p.id as number,
          date: p.paid_on as string,
          amount: p.amount as number,
          purpose: p.purpose as PaymentPurpose,
          channel: p.channel as string | null,
          note: p.note as string | null,
          verified: Boolean(p.verified),
          // The ledger transactions: the linked one, or those added for it.
          transactions: p.transaction_id ? [p.transaction_id as number] : own,
          linked: Boolean(p.transaction_id),
        };
      }),
    };
  }

  // Money in at the bank that could be this lease's rent: not yet a lease payment,
  // from around the lease's dates.
  function candidates(id: number) {
    const row = db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined;
    if (!row) return [];
    const from = new Date(new Date(row.start_date).getTime() - 31 * 864e5).toISOString().slice(0, 10);
    const to = row.end_date || today();
    return (
      db
        .prepare(
          `SELECT t.id, t.posted, t.amount, COALESCE(t.payee, t.description) AS payee, a.name AS account FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
           WHERE t.posted BETWEEN ? AND ? AND t.kind != 'transfer'
             AND NOT EXISTS (SELECT 1 FROM bank_tx_sources s WHERE s.transaction_id = t.id AND s.source = 'lease')
             AND NOT EXISTS (SELECT 1 FROM lease_payments p WHERE p.transaction_id = t.id)
             AND (t.amount > 0 OR t.category = ?)
           ORDER BY t.posted DESC LIMIT 100`
        )
        .all(from, to, SECURITY_DEPOSITS) as Row[]
    ).map((r) => ({ id: r.id as number, posted: r.posted as string, amount: r.amount as number, payee: r.payee as string, account: r.account as string }));
  }

  /* ---------- Changing ---------- */

  function check(input: LeaseInput) {
    if (!input.unit.trim() || !input.tenant.trim()) throw new Error('A lease needs a unit and a tenant.');
    if (input.end && input.end < input.start) throw new Error('The lease ends before it starts.');
  }

  const businessFor = (input: LeaseInput) =>
    input.entityId !== undefined
      ? input.entityId
      : input.propertyId
        ? (((db.prepare('SELECT entity_id FROM stay_properties WHERE id = ?').get(input.propertyId) as Row | undefined)?.entity_id as number | null) ?? null)
        : null;

  function create(input: LeaseInput) {
    check(input);
    const stamp = now();
    return Number(
      db
        .prepare(
          `INSERT INTO leases (ref, property_id, unit, tenant, phone, email, start_date, end_date, rent, deposit, channel, ended, note, created_at, updated_at, entity_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.ref ?? null,
          input.propertyId ?? null,
          input.unit.trim(),
          input.tenant.trim(),
          input.phone ?? null,
          input.email ?? null,
          input.start,
          input.end ?? null,
          input.rent ?? null,
          input.deposit ?? null,
          input.channel ?? null,
          input.ended ? 1 : 0,
          input.note ?? null,
          stamp,
          stamp,
          businessFor(input)
        ).lastInsertRowid
    );
  }

  function update(id: number, input: LeaseInput) {
    check(input);
    const before = db.prepare('SELECT unit, tenant, entity_id FROM leases WHERE id = ?').get(id) as Row | undefined;
    if (!before) return false;
    const entity = input.entityId !== undefined ? input.entityId : (before.entity_id as number | null);
    db.prepare(
      `UPDATE leases SET ref = ?, property_id = ?, unit = ?, tenant = ?, phone = ?, email = ?, start_date = ?, end_date = ?, rent = ?, deposit = ?, channel = ?, ended = ?, note = ?, updated_at = ?, entity_id = ? WHERE id = ?`
    ).run(
      input.ref ?? null,
      input.propertyId ?? null,
      input.unit.trim(),
      input.tenant.trim(),
      input.phone ?? null,
      input.email ?? null,
      input.start,
      input.end ?? null,
      input.rent ?? null,
      input.deposit ?? null,
      input.channel ?? null,
      input.ended ? 1 : 0,
      input.note ?? null,
      now(),
      entity ?? null,
      id
    );
    // The ledger names the unit and tenant, and the business decides the account.
    if (before.unit !== input.unit.trim() || before.tenant !== input.tenant.trim() || (before.entity_id ?? null) !== (entity ?? null))
      for (const p of db.prepare('SELECT id FROM lease_payments WHERE lease_id = ? AND transaction_id IS NULL').all(id) as Row[]) writeLedger(p.id);
    return true;
  }

  function remove(id: number) {
    for (const p of db.prepare('SELECT id FROM lease_payments WHERE lease_id = ?').all(id) as Row[]) removeLedger(p.id);
    return db.prepare('DELETE FROM leases WHERE id = ?').run(id).changes > 0;
  }

  // The rent expected each month, replacing what was there.
  function setSchedule(id: number, months: { month: string; amount: number; note?: string | null }[]) {
    if (!db.prepare('SELECT 1 FROM leases WHERE id = ?').get(id)) throw new Error('That lease was not found.');
    if (months.some((m) => !MONTH.test(m.month))) throw new Error('Months must look like 2026-03.');
    if (new Set(months.map((m) => m.month)).size !== months.length) throw new Error('Each month once.');
    db.prepare('DELETE FROM lease_months WHERE lease_id = ?').run(id);
    const insert = db.prepare('INSERT INTO lease_months (lease_id, month, amount, note) VALUES (?, ?, ?, ?)');
    for (const m of months) insert.run(id, m.month, cents(m.amount), m.note ?? null);
  }

  function checkPayment(input: PaymentInput, paymentId: number | null) {
    if (!(input.amount > 0)) throw new Error('The amount must be more than zero.');
    if (input.transactionId) {
      if (input.purpose === 'applied') throw new Error('Keeping a deposit for rent moves no money, so it has no bank transaction.');
      const tx = bank.transactionById(input.transactionId);
      if (!tx) throw new Error('That transaction was not found.');
      if (toCents(Math.abs(tx.amount)) !== toCents(input.amount)) throw new Error('The amount must match the transaction.');
      if ((input.purpose === 'refund') !== tx.amount < 0) throw new Error(input.purpose === 'refund' ? 'A refund is money going out.' : 'Rent and deposits are money coming in.');
      const taken = db.prepare('SELECT id FROM lease_payments WHERE transaction_id = ? AND id != ?').get(input.transactionId, paymentId ?? 0);
      if (taken) throw new Error('That transaction is already a lease payment.');
    }
  }

  function addPayment(leaseId: number, input: PaymentInput) {
    if (!db.prepare('SELECT 1 FROM leases WHERE id = ?').get(leaseId)) throw new Error('That lease was not found.');
    checkPayment(input, null);
    const id = Number(
      db
        .prepare('INSERT INTO lease_payments (lease_id, paid_on, amount, purpose, channel, note, verified, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(leaseId, input.date, cents(input.amount), input.purpose, input.channel ?? null, input.note ?? null, input.verified === false ? 0 : 1, input.transactionId ?? null, now()).lastInsertRowid
    );
    writeLedger(id);
    return id;
  }

  function updatePayment(leaseId: number, paymentId: number, input: PaymentInput) {
    const before = db.prepare('SELECT * FROM lease_payments WHERE id = ? AND lease_id = ?').get(paymentId, leaseId) as Row | undefined;
    if (!before) throw new Error('That payment was not found.');
    checkPayment(input, paymentId);
    // A transaction it no longer uses goes back to being left to the rules.
    if (before.transaction_id && before.transaction_id !== (input.transactionId ?? null)) bank.updateTransactions([before.transaction_id], { category: null, status: null, kind: null });
    db.prepare('UPDATE lease_payments SET paid_on = ?, amount = ?, purpose = ?, channel = ?, note = ?, verified = ?, transaction_id = ? WHERE id = ?').run(
      input.date,
      cents(input.amount),
      input.purpose,
      input.channel ?? null,
      input.note ?? null,
      input.verified === false ? 0 : 1,
      input.transactionId ?? null,
      paymentId
    );
    writeLedger(paymentId);
  }

  function removePayment(leaseId: number, paymentId: number) {
    const before = db.prepare('SELECT * FROM lease_payments WHERE id = ? AND lease_id = ?').get(paymentId, leaseId) as Row | undefined;
    if (!before) return false;
    removeLedger(paymentId);
    if (before.transaction_id) bank.updateTransactions([before.transaction_id], { category: null, status: null, kind: null });
    db.prepare('DELETE FROM lease_payments WHERE id = ?').run(paymentId);
    return true;
  }

  return { list, get, candidates, create, update, remove, setSchedule, addPayment, updatePayment, removePayment };
}

export type LeaseService = ReturnType<typeof leaseService>;

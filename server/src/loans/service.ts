// Loan balances the bank feed doesn't keep up to date. The user sets the balance once;
// each payment that then reaches the loan account asks for its principal (from the
// bank's website), which comes off the balance. The payment is split into principal
// (a transfer) and interest (an expense) in a split account, and the matching payment
// out of checking is set aside so it isn't counted twice.
import type { DatabaseSync } from 'node:sqlite';
import type { BankStore } from '../bank/store';
import { toCents } from '../bank/types';

type Row = Record<string, any>;

export const LOAN_PAYMENTS = 'Loan & Mortgage Payments';
export const MORTGAGE_INTEREST = 'Mortgage Interest';
const cents = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

export interface PendingPayment {
  transactionId: number;
  accountId: number;
  account: string;
  entityId: number | null;
  date: string;
  amount: number;
  description: string;
  balance: number;
}

export function loanService({ db, bank }: { db: DatabaseSync; bank: BankStore }) {
  const loanRow = (id: number) => db.prepare("SELECT * FROM bank_accounts WHERE id = ? AND kind = 'loan'").get(id) as Row | undefined;

  // Payments into a tracked loan since tracking began, not yet given their principal.
  function pending(): PendingPayment[] {
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, a.id AS account_id, a.name, a.entity_id, a.balance
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE a.kind = 'loan' AND a.balance_manual = 1 AND t.amount > 0 AND t.posted > a.tracked_from
           AND NOT EXISTS (SELECT 1 FROM loan_payments p WHERE p.transaction_id = t.id)
         ORDER BY t.posted, t.id`
      )
      .all() as Row[];
    return rows.map((r) => ({
      transactionId: r.id,
      accountId: r.account_id,
      account: r.name,
      entityId: r.entity_id ?? null,
      date: r.posted,
      amount: r.amount,
      description: r.description,
      balance: r.balance ?? 0,
    }));
  }

  // Each loan account with its balance and the payments recorded against it.
  function list() {
    const loans = db.prepare("SELECT * FROM bank_accounts WHERE kind = 'loan' ORDER BY name COLLATE NOCASE").all() as Row[];
    const payments = db.prepare('SELECT * FROM loan_payments WHERE account_id = ? ORDER BY paid_on DESC, id DESC LIMIT 24');
    return loans.map((a) => ({
      accountId: a.id as number,
      name: a.name as string,
      entityId: (a.entity_id as number | null) ?? null,
      balance: a.balance === null ? null : Math.abs(a.balance as number),
      balanceDate: (a.balance_date as string | null) ?? null,
      tracked: Boolean(a.balance_manual),
      trackedFrom: (a.tracked_from as string | null) ?? null,
      payments: (payments.all(a.id) as Row[]).map((p) => ({
        transactionId: p.transaction_id as number,
        date: p.paid_on as string,
        amount: p.amount as number,
        principal: p.principal as number | null,
        interest: p.interest as number | null,
        balanceAfter: p.balance_after as number | null,
        skipped: p.principal === null,
      })),
    }));
  }

  // Sets the balance (what's owed, as a positive number) and starts tracking from that
  // date: payments after it will ask for their principal. Or stops tracking, after
  // which the bank feed's balance is used again.
  function track(accountId: number, input: { tracked: boolean; balance?: number; asOf?: string; splitAccountId?: number }) {
    const a = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId) as Row | undefined;
    if (!a) throw new Error('That account was not found.');
    // Payments already split by hand into an account of their own carry on there.
    if (input.splitAccountId) {
      if (input.splitAccountId === accountId || !bank.account(input.splitAccountId)) throw new Error('That split account was not found.');
      db.prepare('UPDATE bank_accounts SET split_account_id = ? WHERE id = ?').run(input.splitAccountId, accountId);
    }
    if (!input.tracked) {
      db.prepare('UPDATE bank_accounts SET balance_manual = 0 WHERE id = ?').run(accountId);
      return;
    }
    if (input.balance === undefined) throw new Error('Enter the balance owed.');
    const asOf = input.asOf || today();
    db.prepare("UPDATE bank_accounts SET kind = 'loan', balance_manual = 1, balance = ?, balance_date = ?, tracked_from = ? WHERE id = ?").run(cents(Math.abs(input.balance)), asOf, asOf, accountId);
  }

  // Where a loan's payments are split, made the first time it's needed.
  function splitAccount(loan: Row) {
    const id = loan.split_account_id as number | null;
    if (id && bank.account(id)) return id;
    const made = bank.createAccount({ name: `${loan.name} payment split`.slice(0, 100), kind: 'other', owner: 'business' });
    if (loan.entity_id) bank.updateAccount(made, { entityId: loan.entity_id });
    db.prepare('UPDATE bank_accounts SET split_account_id = ? WHERE id = ?').run(made, loan.id);
    return made;
  }

  // The same payment leaving checking (or another of the business's accounts).
  function paidFrom(loan: Row, split: number, date: string, amount: number) {
    const rows = db
      .prepare(
        `SELECT t.id, t.posted FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE a.kind != 'loan' AND t.account_id NOT IN (?, ?) AND t.kind != 'ignored'
           AND CAST(ROUND(t.amount * 100) AS INTEGER) = ?
           AND t.posted BETWEEN date(?, '-5 days') AND date(?, '+5 days')
           AND (? IS NULL OR a.entity_id = ?)
           AND NOT EXISTS (SELECT 1 FROM loan_payments p WHERE p.paid_from = t.id)
         ORDER BY abs(julianday(t.posted) - julianday(?)), t.id`
      )
      .all(loan.id, split, -toCents(amount), date, date, loan.entity_id ?? null, loan.entity_id ?? null, date) as Row[];
    return (rows[0]?.id as number | undefined) ?? null;
  }

  function payment(transactionId: number) {
    const p = pending().find((x) => x.transactionId === transactionId);
    if (!p) throw new Error('That payment is not waiting for its principal.');
    return p;
  }

  // Records how much of a payment went to principal: the balance goes down by that much,
  // and the payment is split into principal and interest.
  function record(transactionId: number, principal: number) {
    const p = payment(transactionId);
    const loan = loanRow(p.accountId)!;
    const part = cents(principal);
    if (!(part > 0) || part > p.amount) throw new Error(`The principal should be more than $0 and no more than the payment, $${p.amount.toFixed(2)}.`);
    const interest = cents(p.amount - part);
    const owed = Math.abs(loan.balance ?? 0);
    const after = cents(owed - part);
    const split = splitAccount(loan);
    const from = paidFrom(loan, split, p.date, p.amount);

    const stamp = now();
    const insert = db.prepare('INSERT INTO bank_transactions (account_id, posted, amount, description, payee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const source = db.prepare(`INSERT INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, 'loan', ?, ?)`);
    const label = loan.last4 ? `loan ${loan.last4}` : loan.name;
    const line = (amount: number, what: string, n: string) => {
      const id = Number(insert.run(split, p.date, -amount, `${what} (${label})`, loan.name, stamp, stamp).lastInsertRowid);
      source.run(split, `loan-${transactionId}-${n}`, id);
      return id;
    };
    const principalId = line(part, 'Mortgage principal', 'principal');
    bank.updateTransactions([principalId], { category: LOAN_PAYMENTS, status: 'business', kind: 'transfer', ...(loan.entity_id ? { entity: loan.entity_id } : {}) });
    if (interest > 0) {
      const interestId = line(interest, 'Mortgage interest', 'interest');
      bank.updateTransactions([interestId], { category: MORTGAGE_INTEREST, status: 'business', kind: 'normal', ...(loan.entity_id ? { entity: loan.entity_id } : {}) });
    }
    if (from) bank.updateTransactions([from], { kind: 'ignored', note: `Split into principal and interest in "${bank.account(split)?.name}".` });
    // Setting checking's side aside releases the loan's side from their transfer pair;
    // it stays a loan payment, not income.
    bank.updateTransactions([transactionId], { kind: 'transfer', category: LOAN_PAYMENTS, status: 'business' });
    db.prepare(
      'INSERT INTO loan_payments (transaction_id, account_id, paid_on, amount, principal, interest, balance_before, balance_after, paid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(transactionId, p.accountId, p.date, p.amount, part, interest, owed, after, from, stamp);
    db.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ?').run(after, p.date > (loan.balance_date ?? '') ? p.date : loan.balance_date, p.accountId);
    return { balance: after, principal: part, interest, paidFrom: from };
  }

  // A payment that's already counted in the balance (or isn't a loan payment): no change.
  function skip(transactionId: number) {
    const p = payment(transactionId);
    db.prepare('INSERT INTO loan_payments (transaction_id, account_id, paid_on, amount, created_at) VALUES (?, ?, ?, ?, ?)').run(transactionId, p.accountId, p.date, p.amount, now());
  }

  // Takes back the latest recorded payment of a loan, so it can be entered again.
  function undo(transactionId: number) {
    const row = db.prepare('SELECT * FROM loan_payments WHERE transaction_id = ?').get(transactionId) as Row | undefined;
    if (!row) throw new Error('That payment has not been recorded.');
    const latest = db.prepare('SELECT transaction_id FROM loan_payments WHERE account_id = ? AND principal IS NOT NULL ORDER BY paid_on DESC, id DESC LIMIT 1').get(row.account_id) as Row | undefined;
    if (row.principal !== null && latest?.transaction_id !== transactionId) throw new Error('Only the latest payment can be taken back.');
    if (row.principal !== null) {
      const ids = (db.prepare(`SELECT transaction_id FROM bank_tx_sources WHERE source = 'loan' AND external_id LIKE ?`).all(`loan-${transactionId}-%`) as Row[]).map((r) => Number(r.transaction_id));
      if (ids.length) db.prepare(`DELETE FROM bank_transactions WHERE id IN (${ids.join(',')})`).run();
      if (row.paid_from) bank.updateTransactions([row.paid_from], { kind: null });
      db.prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?').run(row.balance_before, row.account_id);
    }
    db.prepare('DELETE FROM loan_payments WHERE transaction_id = ?').run(transactionId);
  }

  return { pending, list, track, record, skip, undo };
}

export type LoanService = ReturnType<typeof loanService>;

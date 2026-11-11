// Bank and card accounts, their transactions, rules and transfer pairing.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fitIdToTransaction } from './ofx';
import { CARD_PAYMENT_WORDS, STORE_PAYEES, TRANSFER_WORDS, categoryHint, payeeFor } from './merchant';
import { toCents } from './types';
import type { AccountKind, IncomingTransaction, Owner, Source, TxKind } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const MATCH_DAYS = 2; // the same payment's date can differ between sources
const TRANSFER_DAYS = 5; // money can take a few days to arrive
const DAY_MS = 86400000;

export interface Account {
  id: number;
  name: string;
  institution: string | null;
  kind: AccountKind;
  owner: Owner;
  last4: string | null;
  currency: string;
  simplefinId: string | null;
  balance: number | null;
  balanceDate: string | null;
  lastSyncedAt: string | null;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  sources: Source[];
}

export interface ImportSummary {
  added: number;
  merged: number;
  skipped: number;
  transfers: number;
  firstDate: string | null;
  lastDate: string | null;
  examples: { posted: string; amount: number; description: string; payee: string }[];
}

export interface TxFilters {
  from?: string | null;
  to?: string | null;
  years?: string[] | null;
  account?: number[] | null;
  category?: string[] | null; // 'none' = no category
  status?: string | null; // business, personal, none
  kind?: string | null; // normal (default), transfer, ignored, all
  direction?: 'in' | 'out' | null;
  q?: string | null;
  review?: boolean;
}

export const NO_CATEGORY = 'none';
const SORTS: Record<string, string> = {
  date: 't.posted',
  amount: 't.amount',
  payee: 'COALESCE(t.payee, t.description) COLLATE NOCASE',
  account: 'a.name COLLATE NOCASE',
  category: 't.category COLLATE NOCASE',
};

const now = () => new Date().toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const plain = (row: Row | undefined) => (row ? { ...row } : undefined);

const NOISE_WORDS = new Set(['pos', 'purchase', 'debit', 'card', 'ach', 'payment', 'the', 'www', 'com', 'inc', 'llc', 'recurring', 'visa', 'checkcard', 'withdrawal', 'online', 'authorized']);
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));

// Whether two descriptions of one payment (from different sources) agree enough.
export function similarDescriptions(a: string, b: string): boolean {
  if (payeeFor(a) === payeeFor(b)) return true;
  const ta = words(a);
  const tb = words(b);
  if (!ta.length || !tb.length) return true; // nothing to compare; amount and date decide
  const na = ta.join(' ');
  const nb = tb.join(' ');
  if (na.length >= 5 && nb.length >= 5 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  const shared = ta.filter((w) => tb.includes(w)).length;
  return shared > 0 && shared / Math.min(ta.length, tb.length) >= 0.5;
}

// An id for a row its source gave none for. Two identical rows (two $5 coffees the
// same day) differ by their position among identical rows.
export function rowId(tx: IncomingTransaction, occurrence: number) {
  const key = `${tx.posted}|${toCents(tx.amount)}|${tx.description.toLowerCase().replace(/\s+/g, ' ').trim()}|${occurrence}`;
  return `h:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export function createBankStore(db: DatabaseSync) {
  function transaction<T>(fn: () => T, rollback = false): T {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------- Settings ---------- */

  const getSetting = (key: string): string | null => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as Row | undefined)?.value ?? null;
  const setSetting = (key: string, value: string | null) => {
    if (value === null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    else db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  };

  /* ---------- Accounts ---------- */

  const toAccount = (row: Row): Account => ({
    id: row.id,
    name: row.name,
    institution: row.institution,
    kind: row.kind,
    owner: row.owner,
    last4: row.last4,
    currency: row.currency,
    simplefinId: row.simplefin_id,
    balance: row.balance,
    balanceDate: row.balance_date,
    lastSyncedAt: row.last_synced_at,
    transactions: row.n ?? 0,
    firstDate: row.first_date ?? null,
    lastDate: row.last_date ?? null,
    sources: row.sources ? (String(row.sources).split(',') as Source[]) : [],
  });

  const ACCOUNT_SQL = `
    SELECT a.*, COUNT(t.id) AS n, MIN(t.posted) AS first_date, MAX(t.posted) AS last_date,
           (SELECT GROUP_CONCAT(DISTINCT s.source) FROM bank_tx_sources s WHERE s.account_id = a.id) AS sources
    FROM bank_accounts a LEFT JOIN bank_transactions t ON t.account_id = a.id`;

  const accounts = (): Account[] => db.prepare(`${ACCOUNT_SQL} GROUP BY a.id ORDER BY a.name COLLATE NOCASE`).all().map((r) => toAccount(r as Row));
  const account = (id: number): Account | null => {
    const row = db.prepare(`${ACCOUNT_SQL} WHERE a.id = ? GROUP BY a.id`).get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  };

  function createAccount(input: {
    name: string;
    institution?: string | null;
    kind?: AccountKind;
    owner?: Owner;
    last4?: string | null;
    currency?: string;
    simplefinId?: string | null;
    fileKey?: string | null;
  }): number {
    const result = db
      .prepare(
        `INSERT INTO bank_accounts (name, institution, kind, owner, last4, currency, simplefin_id, file_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.institution ?? null,
        input.kind ?? 'checking',
        input.owner ?? 'mixed',
        input.last4 ?? null,
        input.currency ?? 'USD',
        input.simplefinId ?? null,
        input.fileKey ?? null,
        now()
      );
    return Number(result.lastInsertRowid);
  }

  function updateAccount(id: number, changes: { name?: string; kind?: AccountKind; owner?: Owner }) {
    const before = account(id);
    if (!before) return null;
    db.prepare('UPDATE bank_accounts SET name = ?, kind = ?, owner = ? WHERE id = ?').run(
      changes.name ?? before.name,
      changes.kind ?? before.kind,
      changes.owner ?? before.owner,
      id
    );
    // The owner sets each transaction's default business or personal status, and the
    // kind decides whether card payments count as transfers.
    transaction(() => {
      applyRules(`t.account_id = ${Number(id)}`);
      detectTransfers();
    });
    return account(id);
  }

  const deleteAccount = (id: number) => db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(id).changes > 0;

  function setBalance(id: number, balance: number | null, balanceDate: string | null) {
    if (balance === null) return;
    db.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ? AND (balance_date IS NULL OR balance_date <= ?)').run(balance, balanceDate, id, balanceDate ?? '9999');
  }

  // A file's account number is kept only as a salted hash, to recognise the account next time.
  const fileKey = (accountNumber: string) => `k:${crypto.createHash('sha256').update(`expense-hub:${accountNumber.replace(/\s/g, '')}`).digest('hex').slice(0, 32)}`;
  const accountForFileKey = (key: string) => (db.prepare('SELECT id FROM bank_accounts WHERE file_key = ?').get(key) as Row | undefined)?.id ?? null;
  const rememberFileKey = (id: number, key: string) => db.prepare('UPDATE bank_accounts SET file_key = ? WHERE id = ? AND file_key IS NULL').run(key, id);

  /* ---------- Rules and categories ---------- */

  type Rule = { id: number; pattern: string; accountId: number | null; category: string | null; status: string | null; kind: string | null };
  const rules = (): Rule[] =>
    db
      .prepare('SELECT id, pattern, account_id, category, status, kind FROM bank_rules ORDER BY LENGTH(pattern) DESC, id')
      .all()
      .map((r) => {
        const row = r as Row;
        return { id: row.id, pattern: row.pattern, accountId: row.account_id, category: row.category, status: row.status, kind: row.kind };
      });

  function saveRule(rule: { pattern: string; accountId?: number | null; category?: string | null; status?: string | null; kind?: string | null }) {
    const id = Number(
      db
        .prepare('INSERT INTO bank_rules (pattern, account_id, category, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rule.pattern, rule.accountId ?? null, rule.category ?? null, rule.status ?? null, rule.kind ?? null, now()).lastInsertRowid
    );
    transaction(() => {
      applyRules();
      detectTransfers();
    });
    return id;
  }

  function deleteRule(id: number) {
    const removed = db.prepare('DELETE FROM bank_rules WHERE id = ?').run(id).changes > 0;
    if (removed)
      transaction(() => {
        applyRules();
        detectTransfers();
      });
    return removed;
  }

  // Sets everything the user hasn't decided themselves: the user's edits, then
  // rules (longest pattern first), then the payee and the account's owner.
  function applyRules(where = '1 = 1') {
    const list = rules();
    const rows = db
      .prepare(`SELECT t.*, a.owner FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id WHERE ${where}`)
      .all() as Row[];
    const update = db.prepare(
      `UPDATE bank_transactions SET category = ?, category_source = ?, status = ?, status_source = ?, kind = ?, kind_source = ?, transfer_id = ?, updated_at = ? WHERE id = ?`
    );
    const unpair = db.prepare(`UPDATE bank_transactions SET transfer_id = NULL, kind = CASE WHEN kind_source = 'auto' THEN 'normal' ELSE kind END, kind_source = CASE WHEN kind_source = 'auto' THEN NULL ELSE kind_source END WHERE id = ?`);
    for (const row of rows) {
      const text = `${row.description} ${row.payee || ''} ${row.memo || ''}`.toLowerCase();
      const matches = list.filter((r) => (r.accountId === null || r.accountId === row.account_id) && text.includes(r.pattern.toLowerCase()));
      const pick = (field: 'category' | 'status' | 'kind') => matches.find((r) => r[field])?.[field] ?? null;

      let { category, category_source: categorySource, status, status_source: statusSource, kind, kind_source: kindSource, transfer_id: transferId } = row;
      if (categorySource !== 'user') {
        const ruled = pick('category');
        const hint = ruled ? null : categoryHint(row.description, row.payee || '', row.amount);
        category = ruled ?? hint;
        categorySource = ruled ? 'rule' : hint ? 'payee' : null;
      }
      if (statusSource !== 'user') {
        const ruled = pick('status');
        const fromOwner = row.owner === 'business' || row.owner === 'personal' ? row.owner : null;
        status = ruled ?? fromOwner;
        statusSource = ruled ? 'rule' : fromOwner ? 'account' : null;
      }
      if (kindSource !== 'user') {
        const ruled = pick('kind');
        if (ruled) {
          if (transferId && kindSource === 'auto') unpair.run(transferId);
          kind = ruled;
          kindSource = 'rule';
          transferId = null;
        } else if (kindSource === 'rule') {
          kind = 'normal';
          kindSource = null;
        }
      }
      update.run(category, categorySource, status, statusSource, kind, kindSource, transferId, now(), row.id);
    }
  }

  // Pairs a payment out of one account with the same amount arriving in another,
  // so moving money (such as paying a card from checking) isn't counted as spending.
  function detectTransfers(): number {
    const rows = db
      .prepare(
        `SELECT t.id, t.account_id, t.posted, t.amount, t.description, a.kind AS account_kind
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.kind_source IS NULL AND t.kind = 'normal' AND t.transfer_id IS NULL
         ORDER BY t.posted, t.id`
      )
      .all() as Row[];
    const inflows = new Map<number, Row[]>();
    for (const row of rows) {
      if (row.amount <= 0) continue;
      const key = toCents(row.amount);
      if (!inflows.has(key)) inflows.set(key, []);
      inflows.get(key)!.push(row);
    }
    const used = new Set<number>();
    const pair = db.prepare(`UPDATE bank_transactions SET kind = 'transfer', kind_source = 'auto', transfer_id = ?, updated_at = ? WHERE id = ?`);
    let paired = 0;
    for (const out of rows) {
      if (out.amount >= 0 || used.has(out.id)) continue;
      const day = dayNumber(out.posted);
      const candidates = (inflows.get(-toCents(out.amount)) || []).filter(
        (inn) =>
          !used.has(inn.id) &&
          inn.account_id !== out.account_id &&
          Math.abs(dayNumber(inn.posted) - day) <= TRANSFER_DAYS &&
          (out.account_kind === 'credit' || inn.account_kind === 'credit' || TRANSFER_WORDS.test(out.description) || TRANSFER_WORDS.test(inn.description))
      );
      if (!candidates.length) continue;
      const match = candidates.reduce((best, c) => (Math.abs(dayNumber(c.posted) - day) < Math.abs(dayNumber(best.posted) - day) ? c : best));
      used.add(out.id);
      used.add(match.id);
      pair.run(match.id, now(), out.id);
      pair.run(out.id, now(), match.id);
      paired++;
    }
    // A payment received on a card, from an account that isn't connected here.
    for (const row of rows) {
      if (used.has(row.id) || row.account_kind !== 'credit' || row.amount <= 0 || !CARD_PAYMENT_WORDS.test(row.description)) continue;
      db.prepare(`UPDATE bank_transactions SET kind = 'transfer', kind_source = 'auto', updated_at = ? WHERE id = ?`).run(now(), row.id);
      paired++;
    }
    return paired;
  }

  /* ---------- Importing ---------- */

  function importTransactions(
    accountId: number,
    source: Source,
    incoming: IncomingTransaction[],
    options: { dryRun?: boolean; fileName?: string | null; username?: string | null } = {}
  ): ImportSummary {
    if (!account(accountId)) throw new Error('That account no longer exists.');
    return transaction(() => {
      const summary: ImportSummary = { added: 0, merged: 0, skipped: 0, transfers: 0, firstDate: null, lastDate: null, examples: [] };
      const findSource = db.prepare('SELECT transaction_id FROM bank_tx_sources WHERE account_id = ? AND source = ? AND external_id = ?');
      const addSource = db.prepare('INSERT OR IGNORE INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, ?, ?, ?)');
      const exported = db.prepare('SELECT id FROM bank_transactions WHERE id = ? AND account_id = ?');
      const candidates = db.prepare(
        `SELECT t.id, t.posted, t.description, t.memo, t.payee FROM bank_transactions t
         WHERE t.account_id = ? AND CAST(ROUND(t.amount * 100) AS INTEGER) = ? AND t.posted BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM bank_tx_sources s WHERE s.transaction_id = t.id AND s.source = ?)`
      );
      const insert = db.prepare(
        `INSERT INTO bank_transactions (account_id, posted, amount, description, payee, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
      const seen = new Map<string, number>();
      const added: number[] = [];

      for (const tx of incoming) {
        const description = tx.description.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Transaction';
        const cents = toCents(tx.amount);
        const plainKey = `${tx.posted}|${cents}|${description.toLowerCase()}`;
        const occurrence = seen.get(plainKey) ?? 0;
        seen.set(plainKey, occurrence + 1);
        const externalId = (tx.externalId && String(tx.externalId).slice(0, 200)) || rowId({ ...tx, description }, occurrence);
        summary.firstDate = !summary.firstDate || tx.posted < summary.firstDate ? tx.posted : summary.firstDate;
        summary.lastDate = !summary.lastDate || tx.posted > summary.lastDate ? tx.posted : summary.lastDate;

        // A file this app exported, being loaded back in.
        const ownId = source === 'ofx' ? fitIdToTransaction(externalId) : null;
        if ((ownId && exported.get(ownId, accountId)) || findSource.get(accountId, source, externalId)) {
          summary.skipped++;
          continue;
        }
        // The same payment already reported by another source.
        // Sources word things differently (a clean name, or the bank's raw text), so any
        // of each side's texts agreeing is enough.
        const ours = [description, tx.memo, tx.payee].filter(Boolean) as string[];
        const matches = (candidates.all(accountId, cents, shift(tx.posted, -MATCH_DAYS), shift(tx.posted, MATCH_DAYS), source) as Row[]).filter((c) =>
          [c.description, c.memo, c.payee].filter(Boolean).some((theirs) => ours.some((mine) => similarDescriptions(theirs, mine)))
        );
        if (matches.length) {
          const day = dayNumber(tx.posted);
          const best = matches.reduce((a, b) => (Math.abs(dayNumber(b.posted) - day) < Math.abs(dayNumber(a.posted) - day) ? b : a));
          addSource.run(accountId, source, externalId, best.id);
          summary.merged++;
          continue;
        }
        const payee = (tx.payee && tx.payee.trim().slice(0, 60)) || payeeFor(description);
        const id = Number(insert.run(accountId, tx.posted, Math.round(tx.amount * 100) / 100, description, payee, tx.memo ? String(tx.memo).slice(0, 500) : null, now(), now()).lastInsertRowid);
        addSource.run(accountId, source, externalId, id);
        added.push(id);
        summary.added++;
        if (summary.examples.length < 5) summary.examples.push({ posted: tx.posted, amount: tx.amount, description, payee });
      }

      if (added.length) applyRules(`t.id IN (${added.join(',')})`);
      summary.transfers = detectTransfers();
      // Daily syncs that found nothing new aren't worth a line in the history.
      const quiet = source === 'simplefin' && !summary.added && !summary.merged;
      if (!options.dryRun && !quiet) {
        db.prepare(
          'INSERT INTO bank_imports (at, username, source, file_name, account_id, added, merged, skipped, first_date, last_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(now(), options.username ?? null, source, options.fileName ?? null, accountId, summary.added, summary.merged, summary.skipped, summary.firstDate, summary.lastDate);
      }
      return summary;
    }, Boolean(options.dryRun));
  }

  const imports = (limit = 20) =>
    db
      .prepare(
        `SELECT i.*, a.name AS account_name FROM bank_imports i LEFT JOIN bank_accounts a ON a.id = i.account_id ORDER BY i.id DESC LIMIT ?`
      )
      .all(limit)
      .map((r) => {
        const row = r as Row;
        return {
          id: row.id,
          at: row.at,
          source: row.source,
          fileName: row.file_name,
          account: row.account_name,
          added: row.added,
          merged: row.merged,
          skipped: row.skipped,
          firstDate: row.first_date,
          lastDate: row.last_date,
        };
      });

  /* ---------- CSV layouts ---------- */

  const csvLayout = (signature: string) => {
    const value = (db.prepare('SELECT mapping FROM csv_layouts WHERE signature = ?').get(signature) as Row | undefined)?.mapping;
    return value ? JSON.parse(value) : null;
  };
  const saveCsvLayout = (signature: string, mapping: unknown) =>
    db
      .prepare('INSERT INTO csv_layouts (signature, mapping, updated_at) VALUES (?, ?, ?) ON CONFLICT (signature) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at')
      .run(signature, JSON.stringify(mapping), now());

  /* ---------- Reading ---------- */

  function whereFor(filters: TxFilters) {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const anyOf = (column: string, values: (string | number)[]) => {
      clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    if (filters.from) {
      clauses.push('t.posted >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('t.posted <= ?');
      params.push(filters.to);
    }
    if (filters.years?.length) anyOf('substr(t.posted, 1, 4)', filters.years);
    if (filters.account?.length) anyOf('t.account_id', filters.account);
    if (filters.category?.length) {
      const named = filters.category.filter((c) => c !== NO_CATEGORY);
      const parts: string[] = [];
      if (named.length) {
        parts.push(`t.category IN (${named.map(() => '?').join(', ')})`);
        params.push(...named);
      }
      if (filters.category.includes(NO_CATEGORY)) parts.push('t.category IS NULL');
      clauses.push(`(${parts.join(' OR ')})`);
    }
    if (filters.status === 'none') clauses.push('t.status IS NULL');
    else if (filters.status) {
      clauses.push('t.status = ?');
      params.push(filters.status);
    }
    const kind = filters.kind || 'normal';
    if (kind !== 'all') {
      clauses.push('t.kind = ?');
      params.push(kind);
    }
    if (filters.direction === 'out') clauses.push('t.amount < 0');
    if (filters.direction === 'in') clauses.push('t.amount > 0');
    if (filters.q) {
      const like = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(t.description LIKE ? ESCAPE '\\' OR t.payee LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (filters.review) {
      // Needs a decision: no business/personal status, or no category (store charges
      // get theirs from matched orders later, so they only need a status).
      clauses.push(`t.kind = 'normal' AND (t.status IS NULL OR (t.category IS NULL AND COALESCE(t.payee, '') NOT IN (${[...STORE_PAYEES].map(() => '?').join(', ')})))`);
      params.push(...STORE_PAYEES);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  const toTransaction = (row: Row) => ({
    id: row.id,
    accountId: row.account_id,
    account: row.account_name,
    posted: row.posted,
    amount: row.amount,
    description: row.description,
    payee: row.payee,
    memo: row.memo,
    kind: row.kind as TxKind,
    kindSource: row.kind_source,
    transferId: row.transfer_id,
    transferAccount: row.transfer_account ?? null,
    category: row.category,
    categorySource: row.category_source,
    status: row.status,
    statusSource: row.status_source,
    note: row.note,
    sources: row.sources ? String(row.sources).split(',') : [],
  });

  function listTransactions(filters: TxFilters, options: { sort?: string; direction?: 'asc' | 'desc'; limit?: number; offset?: number } = {}) {
    const { sql, params } = whereFor(filters);
    const column = SORTS[options.sort || 'date'] || SORTS.date;
    const order = options.direction === 'asc' ? 'ASC' : 'DESC';
    const base = `FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id ${sql}`;
    const totals = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0) AS money_out, COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS money_in ${base}`)
      .get(...params) as Row;
    const limit = options.limit ? `LIMIT ${Number(options.limit)} OFFSET ${Number(options.offset || 0)}` : '';
    const rows = db
      .prepare(
        `SELECT t.*, a.name AS account_name, pa.name AS transfer_account,
                (SELECT GROUP_CONCAT(DISTINCT s.source) FROM bank_tx_sources s WHERE s.transaction_id = t.id) AS sources
         ${base.replace('JOIN bank_accounts a ON a.id = t.account_id', 'JOIN bank_accounts a ON a.id = t.account_id LEFT JOIN bank_transactions p ON p.id = t.transfer_id LEFT JOIN bank_accounts pa ON pa.id = p.account_id')}
         ORDER BY ${column} ${order}, t.posted DESC, t.id DESC ${limit}`
      )
      .all(...params) as Row[];
    return {
      total: totals.n as number,
      moneyOut: Math.round(totals.money_out * 100) / 100,
      moneyIn: Math.round(totals.money_in * 100) / 100,
      transactions: rows.map(toTransaction),
    };
  }

  const reviewCount = () => listTransactions({ review: true, kind: 'normal' }, { limit: 1 }).total;

  /* ---------- Editing ---------- */

  // Each change is the user's own choice; null puts a field back to automatic.
  function updateTransactions(ids: number[], changes: { category?: string | null; status?: string | null; kind?: TxKind | null; note?: string | null }) {
    if (!ids.length) return 0;
    const list = ids.map(Number).filter(Number.isInteger).join(',');
    return transaction(() => {
      const rows = db.prepare(`SELECT id, transfer_id, kind_source FROM bank_transactions WHERE id IN (${list})`).all() as Row[];
      const stamp = now();
      if ('category' in changes) {
        if (changes.category) db.prepare(`UPDATE bank_transactions SET category = ?, category_source = 'user', updated_at = ? WHERE id IN (${list})`).run(changes.category, stamp);
        else db.prepare(`UPDATE bank_transactions SET category_source = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
      }
      if ('status' in changes) {
        if (changes.status) db.prepare(`UPDATE bank_transactions SET status = ?, status_source = 'user', updated_at = ? WHERE id IN (${list})`).run(changes.status, stamp);
        else db.prepare(`UPDATE bank_transactions SET status_source = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
      }
      if ('note' in changes) db.prepare(`UPDATE bank_transactions SET note = ?, updated_at = ? WHERE id IN (${list})`).run(changes.note || null, stamp);
      if ('kind' in changes) {
        // Changing one side of a transfer releases its partner.
        for (const row of rows) {
          if (row.transfer_id && !(changes.kind === 'transfer')) {
            db.prepare(`UPDATE bank_transactions SET transfer_id = NULL, kind = CASE WHEN kind_source = 'auto' THEN 'normal' ELSE kind END, kind_source = CASE WHEN kind_source = 'auto' THEN NULL ELSE kind_source END WHERE id = ?`).run(row.transfer_id);
          }
        }
        if (changes.kind) {
          db.prepare(`UPDATE bank_transactions SET kind = ?, kind_source = 'user', transfer_id = CASE WHEN ? = 'transfer' THEN transfer_id ELSE NULL END, updated_at = ? WHERE id IN (${list})`).run(changes.kind, changes.kind, stamp);
        } else {
          db.prepare(`UPDATE bank_transactions SET kind = 'normal', kind_source = NULL, transfer_id = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
        }
      }
      applyRules(`t.id IN (${list})`);
      detectTransfers();
      return rows.length;
    });
  }

  const deleteTransactions = (accountId: number) => db.prepare('DELETE FROM bank_transactions WHERE account_id = ?').run(accountId).changes;

  /* ---------- Reports ---------- */

  function spending(filters: TxFilters) {
    const { sql, params } = whereFor({ ...filters, kind: 'normal' });
    const base = `FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id ${sql}`;
    const group = (expr: string) =>
      db
        .prepare(
          `SELECT ${expr} AS label, ROUND(SUM(-t.amount), 2) AS spend, COUNT(*) AS n ${base} ${sql ? 'AND' : 'WHERE'} t.amount < 0 GROUP BY label ORDER BY spend DESC`
        )
        .all(...params)
        .map((r) => ({ label: (r as Row).label, spend: (r as Row).spend, transactions: (r as Row).n }));
    return {
      byCategory: group("COALESCE(t.category, 'Uncategorized')"),
      byMonth: group('substr(t.posted, 1, 7)').sort((a, b) => String(a.label).localeCompare(String(b.label))),
      byPayee: group('COALESCE(t.payee, t.description)').slice(0, 15),
    };
  }

  return {
    getSetting,
    setSetting,
    accounts,
    account,
    createAccount,
    updateAccount,
    deleteAccount,
    setBalance,
    fileKey,
    accountForFileKey,
    rememberFileKey,
    markSynced: (id: number) => db.prepare('UPDATE bank_accounts SET last_synced_at = ? WHERE id = ?').run(now(), id),
    accountForSimplefin: (simplefinId: string) => (db.prepare('SELECT id FROM bank_accounts WHERE simplefin_id = ?').get(simplefinId) as Row | undefined)?.id ?? null,
    rules,
    saveRule,
    deleteRule,
    applyRules,
    detectTransfers,
    importTransactions,
    imports,
    csvLayout,
    saveCsvLayout,
    listTransactions,
    reviewCount,
    updateTransactions,
    deleteTransactions,
    spending,
    transactionById: (id: number) => plain(db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id) as Row | undefined),
  };
}

export type BankStore = ReturnType<typeof createBankStore>;

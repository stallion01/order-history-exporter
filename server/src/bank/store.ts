// Bank and card accounts, their transactions, rules and transfer pairing.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fitIdToTransaction } from './ofx';
import { CARD_PAYMENT_WORDS, INCOME_CATEGORIES, REFUNDS, STORE_PAYEES, TRANSFER_WORDS, categoryHint, payeeFor } from './merchant';
import { MONEY_IN, MONEY_OUT } from './csv';
import { toCents } from './types';
import type { AccountKind, IncomingTransaction, Owner, Source, TxKind } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// Money back that isn't income: any positive amount with a spending category, or
// filed as a refund. (Uncategorised money in still counts as income.)
const REFUND_SQL = `(t.amount > 0 AND t.kind = 'normal' AND t.category IS NOT NULL AND t.category NOT IN (${INCOME_CATEGORIES.map((c) => `'${c}'`).join(', ')}))`;
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
  entityId: number | null;
}

export type ImportOutcome = 'added' | 'merged' | 'skipped';
export const IMPORT_OUTCOMES: ImportOutcome[] = ['added', 'merged', 'skipped'];

export interface ImportSummary {
  // The import's id in the history, for listing its transactions (null for a preview).
  importId: number | null;
  added: number;
  merged: number;
  skipped: number;
  transfers: number;
  firstDate: string | null;
  lastDate: string | null;
  examples: { posted: string; amount: number; description: string; payee: string }[];
  // Amounts that came in the wrong way round compared with what was already here (or,
  // on a card, mostly money in), and were turned round.
  signsFixed: number;
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
  // Entities (ids), or 'none' for transactions belonging to no entity.
  entity?: (number | string)[] | null;
  // Store charges not yet matched to an order.
  storeUnlinked?: boolean;
  // Only the transactions one import added, matched or found already there.
  importId?: number | null;
  importOutcome?: ImportOutcome | null;
}

export const NO_CATEGORY = 'none';
export const NO_ENTITY = 'none';

// Payees whose charges are paid store orders, which the extension syncs.
export const ORDER_STORE_PAYEES: Record<string, string[]> = {
  amazon: ['Amazon'],
  ebay: ['eBay', 'PayPal'],
  walmart: ['Walmart'],
  samsclub: ["Sam's Club"],
  newegg: ['Newegg'],
  homedepot: ['Home Depot'],
};
const ALL_STORE_PAYEES = [...new Set(Object.values(ORDER_STORE_PAYEES).flat())];

// What linked store orders say about a transaction.
export interface OrderInfo {
  category: string | null; // the category with the most money in the linked orders
  zips: string[]; // where those orders were delivered
}
export type Share = { entityId: number; percent: number };
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
  const afterImport: (() => void)[] = [];
  // Filled in by the order matching, which knows about orders and items.
  let orderInfo: (ids: number[]) => Map<number, OrderInfo> = () => new Map();
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
    entityId: row.entity_id ?? null,
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

  function updateAccount(id: number, changes: { name?: string; kind?: AccountKind; owner?: Owner; entityId?: number | null }) {
    const before = account(id);
    if (!before) return null;
    db.prepare('UPDATE bank_accounts SET name = ?, kind = ?, owner = ?, entity_id = ? WHERE id = ?').run(
      changes.name ?? before.name,
      changes.kind ?? before.kind,
      changes.owner ?? before.owner,
      'entityId' in changes ? changes.entityId ?? null : before.entityId,
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

  type Rule = {
    id: number;
    pattern: string;
    accountId: number | null;
    category: string | null;
    status: string | null;
    kind: string | null;
    entityId: number | null;
    sharedEntities: number[] | null; // shared equally between these
  };
  const rules = (): Rule[] =>
    db
      .prepare('SELECT id, pattern, account_id, category, status, kind, entity_id, shared_entities FROM bank_rules ORDER BY LENGTH(pattern) DESC, id')
      .all()
      .map((r) => {
        const row = r as Row;
        return {
          id: row.id,
          pattern: row.pattern,
          accountId: row.account_id,
          category: row.category,
          status: row.status,
          kind: row.kind,
          entityId: row.entity_id,
          sharedEntities: row.shared_entities ? (JSON.parse(row.shared_entities) as number[]) : null,
        };
      });

  function saveRule(rule: {
    pattern: string;
    accountId?: number | null;
    category?: string | null;
    status?: string | null;
    kind?: string | null;
    entityId?: number | null;
    sharedEntities?: number[] | null;
  }) {
    const shared = rule.sharedEntities && rule.sharedEntities.length > 1 ? JSON.stringify([...new Set(rule.sharedEntities)]) : null;
    const id = Number(
      db
        .prepare('INSERT INTO bank_rules (pattern, account_id, category, status, kind, entity_id, shared_entities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rule.pattern, rule.accountId ?? null, rule.category ?? null, rule.status ?? null, rule.kind ?? null, shared ? null : rule.entityId ?? null, shared, now()).lastInsertRowid
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

  // Sets everything the user hasn't decided themselves. In order of trust: the
  // user's edits, rules (longest pattern first), the matched store order, the
  // receipt, the payee, and the account's owner and entity.
  function applyRules(where = '1 = 1') {
    const list = rules();
    const rows = db
      .prepare(
        `SELECT t.*, a.owner, a.entity_id AS account_entity, (SELECT r.category FROM receipts r WHERE r.transaction_id = t.id AND r.category IS NOT NULL ORDER BY r.id LIMIT 1) AS receipt_category
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id WHERE ${where}`
      )
      .all() as Row[];
    const fromOrders = orderInfo(rows.map((r) => r.id as number));
    const placeEntity = new Map((db.prepare('SELECT zip, entity_id FROM place_entities').all() as Row[]).map((r) => [r.zip as string, r.entity_id as number]));
    const setEntity = db.prepare('UPDATE bank_transactions SET entity_id = ?, entity_source = ? WHERE id = ?');
    const clearShares = db.prepare('DELETE FROM tx_entity_shares WHERE transaction_id = ?');
    const addShare = db.prepare('INSERT INTO tx_entity_shares (transaction_id, entity_id, percent) VALUES (?, ?, ?)');
    const update = db.prepare(
      `UPDATE bank_transactions SET category = ?, category_source = ?, status = ?, status_source = ?, kind = ?, kind_source = ?, transfer_id = ?, updated_at = ? WHERE id = ?`
    );
    const unpair = db.prepare(`UPDATE bank_transactions SET transfer_id = NULL, kind = CASE WHEN kind_source = 'auto' THEN 'normal' ELSE kind END, kind_source = CASE WHEN kind_source = 'auto' THEN NULL ELSE kind_source END WHERE id = ?`);
    // Money back from a payee this account has paid is a refund: it takes the category
    // of what was bought there, so it reduces that spending instead of counting as income.
    const chargesAt = db.prepare(
      `SELECT category, COUNT(*) AS n FROM bank_transactions WHERE account_id = ? AND payee = ? AND amount < 0 AND kind = 'normal' GROUP BY category ORDER BY category IS NULL, n DESC`
    );
    const refundCategory = (row: Row): string | null => {
      if ((row.amount as number) <= 0 || !row.payee) return null;
      // Deposits, payouts and transfers aren't refunds, whoever they're from.
      const text = `${row.description} ${row.memo || ''}`;
      if (MONEY_IN.test(text) || TRANSFER_WORDS.test(text)) return null;
      const found = chargesAt.all(row.account_id, row.payee) as Row[];
      if (!found.length) return null;
      return (found[0].category as string | null) && !INCOME_CATEGORIES.includes(found[0].category as string) ? (found[0].category as string) : REFUNDS;
    };
    for (const row of rows) {
      const text = `${row.description} ${row.payee || ''} ${row.memo || ''}`.toLowerCase();
      const matches = list.filter((r) => (r.accountId === null || r.accountId === row.account_id) && text.includes(r.pattern.toLowerCase()));
      const pick = (field: 'category' | 'status' | 'kind') => matches.find((r) => r[field])?.[field] ?? null;
      const orders = fromOrders.get(row.id);

      let { category, category_source: categorySource, status, status_source: statusSource, kind, kind_source: kindSource, transfer_id: transferId } = row;
      if (categorySource !== 'user') {
        const ruled = pick('category');
        const fromOrder = ruled ? null : orders?.category ?? null;
        const fromReceipt = ruled || fromOrder ? null : row.receipt_category;
        const hint = ruled || fromOrder || fromReceipt ? null : categoryHint(row.description, row.payee || '', row.amount) ?? refundCategory(row);
        category = ruled ?? fromOrder ?? fromReceipt ?? hint;
        categorySource = ruled ? 'rule' : fromOrder ? 'order' : fromReceipt ? 'receipt' : hint ? 'payee' : null;
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

      // Entity: a rule (one entity, or several sharing equally), then where its
      // store order was delivered, then the account's.
      if (row.entity_source !== 'user') {
        clearShares.run(row.id);
        const ruled = matches.find((r) => r.entityId || r.sharedEntities);
        if (ruled?.sharedEntities) {
          setEntity.run(null, 'rule', row.id);
          const each = Math.round((100 / ruled.sharedEntities.length) * 10000) / 10000;
          for (const entityId of ruled.sharedEntities) addShare.run(row.id, entityId, each);
        } else {
          const place = orders?.zips.map((z) => placeEntity.get(z)).find(Boolean) ?? null;
          const entity = ruled?.entityId ?? place ?? row.account_entity ?? null;
          setEntity.run(entity, ruled?.entityId ? 'rule' : place ? 'place' : entity ? 'account' : null, row.id);
        }
      }
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
      const summary: ImportSummary = { importId: null, added: 0, merged: 0, skipped: 0, transfers: 0, firstDate: null, lastDate: null, examples: [], signsFixed: 0 };
      if (incomingIsBackwards(accountId, source, incoming)) {
        incoming = incoming.map((t) => ({ ...t, amount: -t.amount }));
        summary.signsFixed = incoming.length;
      }
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
      const outcomes: [number, ImportOutcome][] = [];

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
        const already = (ownId ? (exported.get(ownId, accountId) as Row | undefined)?.id : null) ?? (findSource.get(accountId, source, externalId) as Row | undefined)?.transaction_id;
        if (already) {
          outcomes.push([already, 'skipped']);
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
          outcomes.push([best.id, 'merged']);
          summary.merged++;
          continue;
        }
        const payee = (tx.payee && tx.payee.trim().slice(0, 60)) || payeeFor(description);
        const id = Number(insert.run(accountId, tx.posted, Math.round(tx.amount * 100) / 100, description, payee, tx.memo ? String(tx.memo).slice(0, 500) : null, now(), now()).lastInsertRowid);
        addSource.run(accountId, source, externalId, id);
        added.push(id);
        outcomes.push([id, 'added']);
        summary.added++;
        if (summary.examples.length < 5) summary.examples.push({ posted: tx.posted, amount: tx.amount, description, payee });
      }

      if (added.length) applyRules(`t.id IN (${added.join(',')})`);
      summary.transfers = detectTransfers();
      // Daily syncs that found nothing new aren't worth a line in the history.
      const quiet = source === 'simplefin' && !summary.added && !summary.merged;
      // A preview records the import too (it's all undone afterwards), so it can be checked
      // the same way.
      if (!quiet) {
        const importId = Number(
          db
            .prepare(
              'INSERT INTO bank_imports (at, username, source, file_name, account_id, added, merged, skipped, first_date, last_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(now(), options.username ?? null, source, options.fileName ?? null, accountId, summary.added, summary.merged, summary.skipped, summary.firstDate, summary.lastDate).lastInsertRowid
        );
        // Which transactions this import touched, so its result can be listed.
        const remember = db.prepare('INSERT OR IGNORE INTO bank_import_rows (import_id, transaction_id, outcome) VALUES (?, ?, ?)');
        for (const [txId, outcome] of outcomes) remember.run(importId, txId, outcome);
        if (!options.dryRun) summary.importId = importId;

        // Signs that disagree with what's already here: this import is put right.
        const mine = source === 'simplefin' ? 'simplefin' : `import:${importId}`;
        const problems = findSignProblems(accountId).filter((p) => p.group === mine);
        if (problems.length) {
          const fixed = fixSigns(problems);
          summary.signsFixed = fixed.flipped + fixed.merged;
          summary.added -= fixed.merged;
          summary.merged += fixed.merged;
          const turned = new Set(problems.flatMap((p) => p.rows.map((t) => `${t.posted}|${-(t.amount as number)}`)));
          summary.examples = summary.examples.map((e) => (turned.has(`${e.posted}|${-e.amount}`) ? { ...e, amount: -e.amount } : e));
          if (!options.dryRun) db.prepare('UPDATE bank_imports SET added = ?, merged = ? WHERE id = ?').run(summary.added, summary.merged, importId);
        }
      }
      return summary;
    }, Boolean(options.dryRun));
  }
  function importAndNotify(...args: Parameters<typeof importTransactions>): ImportSummary {
    const summary = importTransactions(...args);
    if (!args[3]?.dryRun && summary.added) for (const listener of afterImport) listener();
    return summary;
  }

  const imports = (limit = 20, id: number | null = null) =>
    db
      .prepare(
        `SELECT i.*, a.name AS account_name FROM bank_imports i LEFT JOIN bank_accounts a ON a.id = i.account_id
         ${id === null ? '' : 'WHERE i.id = ?'} ORDER BY i.id DESC LIMIT ?`
      )
      .all(...(id === null ? [limit] : [id, limit]))
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
          accountId: row.account_id,
        };
      });
  const importById = (id: number) => imports(1, id)[0] ?? null;

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
    // Spending includes refunds (money back that reduces it); income leaves them out.
    if (filters.direction === 'out') clauses.push(`(t.amount < 0 OR ${REFUND_SQL})`);
    if (filters.direction === 'in') clauses.push(`(t.amount > 0 AND NOT ${REFUND_SQL})`);
    if (filters.q) {
      const like = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(t.description LIKE ? ESCAPE '\\' OR t.payee LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (filters.entity?.length) {
      const ids = filters.entity.filter((e) => e !== NO_ENTITY).map(Number);
      const parts: string[] = [];
      if (ids.length) {
        const marks = ids.map(() => '?').join(', ');
        parts.push(`t.entity_id IN (${marks}) OR EXISTS (SELECT 1 FROM tx_entity_shares es WHERE es.transaction_id = t.id AND es.entity_id IN (${marks}))`);
        params.push(...ids, ...ids);
      }
      if (filters.entity.includes(NO_ENTITY)) parts.push('(t.entity_id IS NULL AND NOT EXISTS (SELECT 1 FROM tx_entity_shares es WHERE es.transaction_id = t.id))');
      clauses.push(`(${parts.join(' OR ')})`);
    }
    if (filters.storeUnlinked) {
      clauses.push(
        `t.amount < 0 AND t.kind = 'normal' AND t.payee IN (${ALL_STORE_PAYEES.map(() => '?').join(', ')}) AND NOT EXISTS (SELECT 1 FROM order_links l WHERE l.transaction_id = t.id)`
      );
      params.push(...ALL_STORE_PAYEES);
    }
    if (filters.importId) {
      clauses.push(`EXISTS (SELECT 1 FROM bank_import_rows r WHERE r.transaction_id = t.id AND r.import_id = ?${filters.importOutcome ? ' AND r.outcome = ?' : ''})`);
      params.push(filters.importId, ...(filters.importOutcome ? [filters.importOutcome] : []));
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
    receiptId: row.receipt_id ?? null,
    entityId: row.entity_id ?? null,
    entitySource: row.entity_source ?? null,
    shares: row.shares
      ? String(row.shares)
          .split(',')
          .map((pair) => {
            const [entityId, percent] = pair.split(':');
            return { entityId: Number(entityId), percent: Number(percent) };
          })
      : [],
    orders: row.linked_orders
      ? String(row.linked_orders)
          .split('\u0001')
          .map((pair) => {
            const [store, orderId, amount] = pair.split('\u0002');
            return { store, orderId, amount: Number(amount) };
          })
      : [],
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
                (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id ORDER BY r.id LIMIT 1) AS receipt_id,
                (SELECT GROUP_CONCAT(es.entity_id || ':' || es.percent) FROM tx_entity_shares es WHERE es.transaction_id = t.id) AS shares,
                (SELECT GROUP_CONCAT(l.store || char(2) || l.order_id || char(2) || l.amount, char(1)) FROM order_links l WHERE l.transaction_id = t.id) AS linked_orders,
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
  /* ---------- Amounts the wrong way round ---------- */

  const unpairStmt = () =>
    db.prepare(
      `UPDATE bank_transactions SET transfer_id = NULL, kind = CASE WHEN kind_source = 'auto' THEN 'normal' ELSE kind END, kind_source = CASE WHEN kind_source = 'auto' THEN NULL ELSE kind_source END WHERE id = ?`
    );

  // Turns amounts round (money in shown as spending, or the reverse). Callers re-run
  // the rules and transfer matching afterwards.
  function flipRows(rows: Row[]) {
    const unpair = unpairStmt();
    const csvIds = db.prepare(`SELECT external_id FROM bank_tx_sources WHERE transaction_id = ? AND source = 'csv' AND external_id LIKE 'h:%'`);
    const addSource = db.prepare('INSERT OR IGNORE INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, ?, ?, ?)');
    const flip = db.prepare('UPDATE bank_transactions SET amount = -amount, updated_at = ? WHERE id = ?');
    for (const row of rows) {
      // An automatic transfer pair no longer adds up; it's looked for again afterwards.
      if (row.transfer_id && row.kind_source === 'auto') {
        unpair.run(row.transfer_id);
        unpair.run(row.id);
      }
      flip.run(now(), row.id);
      // Rows from a CSV are known by a fingerprint that includes the amount. Knowing
      // the corrected one too means importing the same file again with the right
      // signs adds nothing.
      if ((csvIds.all(row.id) as Row[]).length) {
        const tx = { posted: row.posted as string, amount: -(row.amount as number), description: row.description as string, externalId: null };
        for (let occurrence = 0; occurrence < 3; occurrence++) addSource.run(row.account_id, 'csv', rowId(tx, occurrence), row.id);
      }
    }
  }

  // One transaction that came in twice, once each way round: the wrong one's sources,
  // receipts, order links and the user's own choices move to the right one, and the
  // wrong one goes.
  function mergeInto(wrong: Row, keep: Row) {
    const w = wrong.id as number;
    const k = keep.id as number;
    if (wrong.transfer_id && wrong.kind_source === 'auto') unpairStmt().run(wrong.transfer_id);
    db.prepare('UPDATE OR IGNORE bank_tx_sources SET transaction_id = ? WHERE transaction_id = ?').run(k, w);
    const csvIds = db.prepare(`SELECT 1 FROM bank_tx_sources WHERE transaction_id = ? AND source = 'csv' AND external_id LIKE 'h:%'`).get(k);
    if (csvIds) {
      const tx = { posted: wrong.posted as string, amount: -(wrong.amount as number), description: wrong.description as string, externalId: null };
      const addSource = db.prepare('INSERT OR IGNORE INTO bank_tx_sources (account_id, source, external_id, transaction_id) VALUES (?, ?, ?, ?)');
      for (let occurrence = 0; occurrence < 3; occurrence++) addSource.run(wrong.account_id, 'csv', rowId(tx, occurrence), k);
    }
    db.prepare(`UPDATE OR IGNORE bank_import_rows SET transaction_id = ?, outcome = 'merged' WHERE transaction_id = ?`).run(k, w);
    db.prepare('UPDATE receipts SET transaction_id = ? WHERE transaction_id = ?').run(k, w);
    db.prepare('UPDATE OR IGNORE order_links SET transaction_id = ? WHERE transaction_id = ?').run(k, w);
    db.prepare('UPDATE OR IGNORE order_link_rejections SET transaction_id = ? WHERE transaction_id = ?').run(k, w);
    db.prepare('UPDATE OR IGNORE assets SET transaction_id = ? WHERE transaction_id = ?').run(k, w);
    const both = db.prepare('SELECT * FROM bank_transactions WHERE id = ?');
    const from = both.get(w) as Row;
    const to = both.get(k) as Row;
    if (from.category_source === 'user' && to.category_source !== 'user')
      db.prepare(`UPDATE bank_transactions SET category = ?, category_source = 'user' WHERE id = ?`).run(from.category, k);
    if (from.status_source === 'user' && to.status_source !== 'user') db.prepare(`UPDATE bank_transactions SET status = ?, status_source = 'user' WHERE id = ?`).run(from.status, k);
    if (from.kind_source === 'user' && to.kind_source !== 'user') db.prepare(`UPDATE bank_transactions SET kind = ?, kind_source = 'user', transfer_id = NULL WHERE id = ?`).run(from.kind, k);
    if (from.note && !to.note) db.prepare('UPDATE bank_transactions SET note = ? WHERE id = ?').run(from.note, k);
    if (from.entity_source === 'user' && to.entity_source !== 'user') {
      db.prepare('DELETE FROM tx_entity_shares WHERE transaction_id = ?').run(k);
      db.prepare(`UPDATE OR IGNORE tx_entity_shares SET transaction_id = ? WHERE transaction_id = ?`).run(k, w);
      db.prepare(`UPDATE bank_transactions SET entity_id = ?, entity_source = 'user' WHERE id = ?`).run(from.entity_id, k);
    }
    db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(w);
  }

  // Finds transactions that came in the wrong way round. Each import (and all of
  // SimpleFIN's syncs together) is judged as a whole, since one file is read one way:
  //  - two imports that report the same charges with opposite signs disagree, and the
  //    one with the wrong sign is worked out from the wording (a payout or deposit is
  //    money in, a purchase or withdrawal money out), then, for a card, from which
  //    is mostly positive (purchases outnumber payments), then by trusting the bank's
  //    own feed over an OFX file over a CSV, whose signs had to be guessed;
  //  - on a card, an import that is mostly money in, when the rest of the card isn't
  //    or its wording says so, is the wrong way round on its own.
  function findSignProblems(accountId: number | null = null) {
    const where = accountId === null ? '' : 'AND t.account_id = ?';
    const rows = db
      .prepare(
        `SELECT t.id, t.account_id, t.posted, t.amount, t.description, t.memo, t.payee, t.transfer_id, t.kind_source, a.kind AS account_kind, a.name AS account_name,
                (SELECT r.import_id FROM bank_import_rows r WHERE r.transaction_id = t.id AND r.outcome = 'added' ORDER BY r.import_id LIMIT 1) AS import_id,
                (SELECT s.source FROM bank_tx_sources s WHERE s.transaction_id = t.id ORDER BY s.rowid LIMIT 1) AS source,
                (SELECT group_concat(r.import_id) FROM bank_import_rows r WHERE r.transaction_id = t.id AND r.outcome = 'merged') AS merged_imports,
                EXISTS (SELECT 1 FROM bank_tx_sources s WHERE s.transaction_id = t.id AND s.source = 'simplefin') AS has_simplefin
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount != 0 ${where}`
      )
      .all(...(accountId === null ? [] : [accountId])) as Row[];
    const importSource = new Map((db.prepare('SELECT id, source FROM bank_imports').all() as Row[]).map((r) => [r.id as number, r.source as string]));
    const groupOf = (importId: number | null, source: string | null) =>
      source === 'simplefin' || (importId !== null && importSource.get(importId) === 'simplefin') ? 'simplefin' : importId !== null ? `import:${importId}` : `source:${source}`;
    const RANK: Record<string, number> = { simplefin: 3, ofx: 2, csv: 1 };
    const rankOf = (group: string) => (group === 'simplefin' ? 3 : RANK[group.startsWith('import:') ? importSource.get(Number(group.slice(7))) || '' : group.slice(7)] ?? 0);

    type Tx = Row & { group: string; touched: Set<string>; cents: number; day: number; texts: string[] };
    const byAccount = new Map<number, Tx[]>();
    for (const row of rows) {
      if (row.source === 'receipt') continue; // cash recorded from a receipt
      const group = groupOf(row.import_id as number | null, row.source as string | null);
      const touched = new Set([group]);
      for (const id of String(row.merged_imports || '').split(',').filter(Boolean)) touched.add(groupOf(Number(id), null));
      if (row.has_simplefin) touched.add('simplefin');
      const tx = Object.assign(row, { group, touched, cents: toCents(row.amount as number), day: dayNumber(row.posted as string), texts: [row.description, row.memo, row.payee].filter(Boolean) as string[] }) as Tx;
      const list = byAccount.get(row.account_id as number) || [];
      list.push(tx);
      byAccount.set(row.account_id as number, list);
    }

    // Wording that says which way the money went, against the sign it has.
    const evidence = (list: Tx[]) => {
      let asIs = 0;
      let flipped = 0;
      for (const t of list) {
        const text = t.texts.join(' ');
        const way = MONEY_IN.test(text) ? 1 : MONEY_OUT.test(text) ? -1 : 0;
        if (way) Math.sign(t.cents) === way ? asIs++ : flipped++;
      }
      return { asIs, flipped };
    };
    // A rough payee from the first words, the same for every row of one file.
    const payeeKey = (t: Tx) => String(t.description).toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
    const positiveShare = (list: Tx[]) => (list.length ? list.filter((t) => t.cents > 0).length / list.length : 0);

    const problems: { accountId: number; account: string; group: string; rows: Tx[]; twins: Map<number, Tx> }[] = [];
    for (const [acct, list] of byAccount) {
      const groups = new Map<string, Tx[]>();
      for (const t of list) groups.set(t.group, [...(groups.get(t.group) || []), t]);
      const card = list[0].account_kind === 'credit';
      // Imports found to be the wrong way round: each row's copy from the right source,
      // and payees already put right.
      const fixOf = new Map<string, { twins: Map<number, Tx>; keep: Set<string> }>();

      // Pairs of imports that disagree. Each transaction reported by both (same amount,
      // within a couple of days, similar wording) is a pair. They disagree when most
      // pairs, or most payees among them, have opposite signs. Counting payees as well
      // as rows keeps the answer clear when some rows were already swapped by hand
      // (say, every Airbnb payout): those pairs agree, but they're one payee.
      const names = [...groups.keys()];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const [g, h] = [names[i], names[j]];
          const a = groups.get(g)!;
          const b = groups.get(h)!;
          const merged = [...a.filter((t) => t.touched.has(h)), ...b.filter((t) => t.touched.has(g))];
          const used = new Set<number>();
          const pairs: [Tx, Tx][] = [];
          for (const t of a) {
            if (t.touched.has(h)) continue;
            let best: Tx | null = null;
            for (const u of b) {
              if (used.has(u.id as number) || u.touched.has(g) || Math.abs(u.cents) !== Math.abs(t.cents) || Math.abs(u.day - t.day) > MATCH_DAYS) continue;
              if (!u.texts.some((x) => t.texts.some((y) => similarDescriptions(x, y)))) continue;
              // The closest date wins; on a tie, the one with the opposite sign.
              const better = !best || Math.abs(u.day - t.day) < Math.abs(best.day - t.day) || (Math.abs(u.day - t.day) === Math.abs(best.day - t.day) && u.cents === -t.cents && best.cents !== -t.cents);
              if (better) best = u;
            }
            if (best) {
              used.add(best.id as number);
              pairs.push([t, best]);
            }
          }
          const opposite = pairs.filter(([t, u]) => t.cents === -u.cents);
          const agreeing = pairs.length - opposite.length + merged.length;
          const tally = (side: 0 | 1) => {
            const byPayee = new Map<string, { opposite: number; same: number }>();
            for (const pair of pairs) {
              const k = payeeKey(pair[side]);
              const v = byPayee.get(k) || { opposite: 0, same: 0 };
              if (pair[0].cents === -pair[1].cents) v.opposite++;
              else v.same++;
              byPayee.set(k, v);
            }
            for (const t of merged) {
              const k = payeeKey(t);
              const v = byPayee.get(k) || { opposite: 0, same: 0 };
              v.same++;
              byPayee.set(k, v);
            }
            return byPayee;
          };
          const payeesA = tally(0);
          const oppositePayees = [...payeesA.values()].filter((v) => v.opposite > v.same).length;
          const samePayees = [...payeesA.values()].filter((v) => v.same >= v.opposite).length;
          const disagree = (opposite.length >= 2 && opposite.length > 2 * agreeing) || (oppositePayees >= 2 && oppositePayees > 2 * samePayees);
          if (!disagree) continue;

          // Which side is wrong: the wording of the disagreeing rows, then (on a card)
          // which is mostly money in, then which source's signs are more trustworthy.
          const eg = evidence(opposite.map((p) => p[0]));
          const eh = evidence(opposite.map((p) => p[1]));
          let bad: string | null = null;
          if (eg.flipped > eg.asIs && eh.flipped <= eh.asIs) bad = g;
          else if (eh.flipped > eh.asIs && eg.flipped <= eg.asIs) bad = h;
          else if (card && Math.abs(positiveShare(a) - positiveShare(b)) >= 0.2) bad = positiveShare(a) > positiveShare(b) ? g : h;
          else if (rankOf(g) !== rankOf(h)) bad = rankOf(g) < rankOf(h) ? g : h;
          if (!bad) continue;
          const side = bad === g ? 0 : 1;
          const fix = fixOf.get(bad) || { twins: new Map<number, Tx>(), keep: new Set<string>() };
          // Every pair is one transaction reported twice: the wrong side's copy goes.
          for (const pair of pairs) fix.twins.set(pair[side].id as number, pair[1 - side]);
          // Payees whose pairs already agree were put right before (or were never wrong).
          for (const [k, v] of side === 0 ? payeesA : tally(1)) if (v.same >= v.opposite) fix.keep.add(k);
          fixOf.set(bad, fix);
        }
      }

      for (const [g, a] of groups) {
        if (fixOf.has(g)) continue;
        const e = evidence(a);
        if (e.asIs > e.flipped) continue;
        // Wording alone, when it clearly says so: "transfer to savings" as money in,
        // "interest earned" as money out.
        let reversed = e.flipped >= 3 && e.flipped >= 4 * e.asIs;
        // On a card: an import that is mostly money in, when the rest of the card isn't.
        if (!reversed && card && a.length >= 4 && positiveShare(a) >= 0.7) {
          const rest = list.filter((t) => t.group !== g && !fixOf.has(t.group));
          reversed = e.flipped > e.asIs || (rest.length >= 4 && positiveShare(rest) <= 0.4);
        }
        if (reversed) fixOf.set(g, { twins: new Map(), keep: new Set() });
      }

      for (const [g, fix] of fixOf) {
        // A transaction another, trusted source also reported this way round is left be.
        const mine = groups.get(g)!.filter((t) => [...t.touched].every((x) => x === g || fixOf.has(x)) && (fix.twins.has(t.id as number) || !fix.keep.has(payeeKey(t))));
        if (mine.length) problems.push({ accountId: acct, account: list[0].account_name as string, group: g, rows: mine, twins: fix.twins });
      }
    }
    return problems;
  }

  // Before importing: does this file report, the opposite way round, what's already in
  // the account (by the same row's id, or the same payment from another source)?
  // When it consistently does, and its own wording doesn't say it's right, the file
  // is the one that's backwards: what's here may already have been checked.
  function incomingIsBackwards(accountId: number, source: Source, incoming: IncomingTransaction[]) {
    if (incoming.length < 2) return false;
    const dates = incoming.map((t) => t.posted).sort();
    const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
    const existing = db
      .prepare('SELECT id, posted, amount, description, memo, payee FROM bank_transactions WHERE account_id = ? AND posted BETWEEN ? AND ?')
      .all(accountId, shift(dates[0], -MATCH_DAYS), shift(dates[dates.length - 1], MATCH_DAYS)) as Row[];
    if (!existing.length) return false;
    const byId = new Map(existing.map((r) => [r.id as number, r]));
    const findSource = db.prepare('SELECT transaction_id FROM bank_tx_sources WHERE account_id = ? AND source = ? AND external_id = ?');
    const seen = new Map<string, number>();
    let same = 0;
    let opposite = 0;
    const disagreeing: Row[] = [];
    for (const tx of incoming) {
      const cents = toCents(tx.amount);
      if (!cents) continue;
      const description = tx.description.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Transaction';
      const key = `${tx.posted}|${cents}|${description.toLowerCase()}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const externalId = (tx.externalId && String(tx.externalId).slice(0, 200)) || rowId({ ...tx, description }, occurrence);
      const known = (findSource.get(accountId, source, externalId) as Row | undefined)?.transaction_id as number | undefined;
      const stored = known === undefined ? undefined : byId.get(known);
      if (stored) {
        const storedCents = toCents(stored.amount as number);
        if (storedCents === cents) same++;
        else if (storedCents === -cents) {
          opposite++;
          disagreeing.push(stored);
        }
        continue;
      }
      const day = dayNumber(tx.posted);
      const ours = [description, tx.memo, tx.payee].filter(Boolean) as string[];
      const near = existing.filter(
        (r) =>
          Math.abs(toCents(r.amount as number)) === Math.abs(cents) &&
          Math.abs(dayNumber(r.posted as string) - day) <= MATCH_DAYS &&
          [r.description, r.memo, r.payee].filter(Boolean).some((theirs) => ours.some((mine) => similarDescriptions(theirs as string, mine)))
      );
      if (near.some((r) => toCents(r.amount as number) === cents)) same++;
      else if (near.length) {
        opposite++;
        disagreeing.push(near[0]);
      }
    }
    if (opposite < 2 || opposite <= 2 * same) return false;
    // They disagree; which is wrong is decided as for two imports already here.
    let asIs = 0;
    let flipped = 0;
    for (const tx of incoming) {
      const text = [tx.description, tx.memo, tx.payee].filter(Boolean).join(' ');
      const way = MONEY_IN.test(text) ? 1 : MONEY_OUT.test(text) ? -1 : 0;
      if (way && tx.amount) Math.sign(tx.amount) === way ? asIs++ : flipped++;
    }
    if (asIs !== flipped) return flipped > asIs;
    const share = (amounts: number[]) => amounts.filter((n) => n > 0).length / Math.max(amounts.length, 1);
    if (account(accountId)?.kind === 'credit') {
      const mine = share(incoming.map((t) => t.amount));
      const theirs = share(existing.map((r) => r.amount as number));
      if (Math.abs(mine - theirs) >= 0.2) return mine > theirs;
    }
    const RANK: Record<string, number> = { simplefin: 3, ofx: 2, csv: 1 };
    const sourceOf = db.prepare('SELECT source FROM bank_tx_sources WHERE transaction_id = ? ORDER BY rowid LIMIT 1');
    const ranks = disagreeing.map((r) => RANK[(sourceOf.get(r.id) as Row | undefined)?.source as string] ?? 0);
    const theirRank = ranks.sort((a, b) => a - b)[Math.floor(ranks.length / 2)] ?? 0;
    return (RANK[source] ?? 0) < theirRank;
  }

  // Puts them right: a transaction that also came in the right way round is merged
  // into that one; the rest are turned round.
  function fixSigns(problems: ReturnType<typeof findSignProblems>) {
    let flipped = 0;
    let merged = 0;
    const touched: number[] = [];
    for (const p of problems) {
      const lone: Row[] = [];
      for (const t of p.rows) {
        const twin = p.twins.get(t.id as number);
        if (twin && db.prepare('SELECT 1 FROM bank_transactions WHERE id = ?').get(twin.id)) {
          mergeInto(t, twin);
          touched.push(twin.id as number);
          merged++;
        } else {
          lone.push(t);
          touched.push(t.id as number);
        }
      }
      flipRows(lone);
      flipped += lone.length;
    }
    if (touched.length) {
      applyRules(`t.id IN (${touched.join(',')})`);
      detectTransfers();
    }
    return { flipped, merged };
  }

  const groupLabel = (group: string) => {
    if (group === 'simplefin') return 'SimpleFIN';
    if (group.startsWith('source:')) return `${group.slice(7).toUpperCase()} rows`;
    const i = db.prepare('SELECT file_name, source, at FROM bank_imports WHERE id = ?').get(Number(group.slice(7))) as Row | undefined;
    return i ? `${i.file_name || String(i.source).toUpperCase() + ' file'}, imported ${String(i.at).slice(0, 10)}` : 'An import';
  };
  const signProblems = () =>
    findSignProblems().map((p) => ({
      key: `${p.accountId}|${p.group}`,
      accountId: p.accountId,
      account: p.account,
      from: groupLabel(p.group),
      count: p.rows.length,
      duplicates: p.rows.filter((t) => p.twins.has(t.id as number)).length,
      examples: p.rows.slice(0, 5).map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, payee: t.payee || t.description })),
    }));
  const fixSignProblems = (keys: string[] | null = null) =>
    transaction(() => fixSigns(findSignProblems().filter((p) => !keys || keys.includes(`${p.accountId}|${p.group}`))));

  function updateTransactions(
    ids: number[],
    changes: { category?: string | null; status?: string | null; kind?: TxKind | null; note?: string | null; entity?: number | null; shares?: Share[] | null; flipSign?: boolean }
  ) {
    if (!ids.length) return 0;
    const list = ids.map(Number).filter(Number.isInteger).join(',');
    return transaction(() => {
      const rows = db.prepare(`SELECT id, account_id, posted, amount, description, transfer_id, kind_source FROM bank_transactions WHERE id IN (${list})`).all() as Row[];
      const stamp = now();
      // Imported the wrong way round (money in shown as spending, or the reverse).
      if (changes.flipSign) flipRows(rows);
      if ('category' in changes) {
        if (changes.category) db.prepare(`UPDATE bank_transactions SET category = ?, category_source = 'user', updated_at = ? WHERE id IN (${list})`).run(changes.category, stamp);
        else db.prepare(`UPDATE bank_transactions SET category_source = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
      }
      if ('status' in changes) {
        if (changes.status) db.prepare(`UPDATE bank_transactions SET status = ?, status_source = 'user', updated_at = ? WHERE id IN (${list})`).run(changes.status, stamp);
        else db.prepare(`UPDATE bank_transactions SET status_source = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
      }
      if ('note' in changes) db.prepare(`UPDATE bank_transactions SET note = ?, updated_at = ? WHERE id IN (${list})`).run(changes.note || null, stamp);
      if ('entity' in changes || 'shares' in changes) {
        db.prepare(`DELETE FROM tx_entity_shares WHERE transaction_id IN (${list})`).run();
        if (changes.shares && changes.shares.length > 1) {
          db.prepare(`UPDATE bank_transactions SET entity_id = NULL, entity_source = 'user', updated_at = ? WHERE id IN (${list})`).run(stamp);
          const add = db.prepare('INSERT INTO tx_entity_shares (transaction_id, entity_id, percent) VALUES (?, ?, ?)');
          for (const id of ids) for (const share of changes.shares) add.run(id, share.entityId, share.percent);
        } else if (changes.entity) {
          db.prepare(`UPDATE bank_transactions SET entity_id = ?, entity_source = 'user', updated_at = ? WHERE id IN (${list})`).run(changes.entity, stamp);
        } else {
          db.prepare(`UPDATE bank_transactions SET entity_source = NULL, updated_at = ? WHERE id IN (${list})`).run(stamp);
        }
      }
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
      // Refunds from the same stores follow their purchases' new category.
      if ('category' in changes)
        applyRules(
          `t.amount > 0 AND (t.category_source IS NULL OR t.category_source = 'payee') AND (t.account_id, t.payee) IN (SELECT account_id, payee FROM bank_transactions WHERE id IN (${list}))`
        );
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

  // Once: earlier versions counted refunds as income; give them their categories.
  if (getSetting('refunds_categorised') !== '1') {
    applyRules("t.amount > 0 AND (t.category_source IS NULL OR t.category_source = 'payee')");
    setSetting('refunds_categorised', '1');
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
    importTransactions: importAndNotify,
    onImport: (listener: () => void) => afterImport.push(listener),
    imports,
    importById,
    csvLayout,
    saveCsvLayout,
    listTransactions,
    reviewCount,
    updateTransactions,
    signProblems,
    fixSignProblems,
    deleteTransactions,
    spending,
    setOrderInfo: (fn: (ids: number[]) => Map<number, OrderInfo>) => {
      orderInfo = fn;
    },
    transactionById: (id: number) => plain(db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id) as Row | undefined),
  };
}

export type BankStore = ReturnType<typeof createBankStore>;

// Phase 5: the year's books for a CPA. Each line of spending gets a class
// (operating, cost of goods sold, capital, personal) and a Schedule C or E line;
// capital purchases go on an asset register; and what still needs a decision is listed.
import { FORM_KEYS } from '../legacy';
import type { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_NUMBER_IN_PAYMENT, OWNER_CONTRIBUTION, OWNER_WITHDRAWAL, PAID_TO_CARD } from '../bank/merchant';
import type { BankStore } from '../bank/store';
import type { CorrelationService, SpendLine } from '../correlate/service';
import type { OrdersDb } from '../legacy';
import type { ReceiptService } from '../receipts/service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// The IRS de minimis safe harbor: items under this can usually be expensed; larger
// ones may need to be capitalized. Flagged for review, never decided automatically.
export const DE_MINIMIS = 2500;

export const RECOVERY_PERIODS: [string, string][] = [
  ['5', '5 years: computers, appliances and carpets in a rental, vehicles'],
  ['7', '7 years: furniture, office equipment'],
  ['15', '15 years: land improvements such as fences, driveways, landscaping'],
  ['27.5', '27.5 years: residential rental building and its improvements'],
  ['39', '39 years: commercial building and its improvements'],
];

export type ExpenseClass = 'opex' | 'cogs' | 'capex' | 'personal';
export const CLASS_LABELS: Record<ExpenseClass, string> = {
  opex: 'Operating expense',
  cogs: 'Cost of goods sold',
  capex: 'Capital purchase',
  personal: 'Personal',
};

// The tax form a business files: its own choice, or Schedule E for a rental and C otherwise.
export const formOf = (entity: { kind: string; taxForm?: string | null } | undefined) => entity?.taxForm || (entity?.kind === 'rental' ? 'schedule-e' : 'schedule-c');

export interface YearLine extends SpendLine {
  class: ExpenseClass;
  entity: string | null;
  form: string; // the tax form id, such as schedule-c or form-8825
  line: string | null; // the form's line, if the category has one
  key: string; // what a capital decision is about: a whole transaction, or one order item
}

const now = () => new Date().toISOString();
const cents = (n: number) => Math.round(n * 100) / 100;
const lineKey = (l: SpendLine) => (l.item ? `item:${l.txId}:${l.item.store}:${l.item.orderId}:${l.item.name.toLowerCase()}` : `tx:${l.txId}`);

export function cpaService(options: { raw: DatabaseSync; db: OrdersDb; bank: BankStore; correlate: CorrelationService; receipts: ReceiptService }) {
  const { raw, db, bank, correlate, receipts } = options;

  /* ---------- Assets ---------- */

  const toAsset = (r: Row) => ({
    id: r.id as number,
    description: r.description as string,
    cost: r.cost as number,
    placedInService: r.placed_in_service as string,
    entityId: r.entity_id as number | null,
    entity: (r.entity_name as string) ?? null,
    recovery: r.recovery as string | null,
    transactionId: r.transaction_id as number | null,
    itemKey: r.item_key as string | null,
    note: r.note as string | null,
    source: r.tx_payee ? `${r.tx_payee} on ${r.tx_posted}` : null,
  });

  const assets = (year: number | null = null) =>
    (raw
      .prepare(
        `SELECT a.*, e.name AS entity_name, t.payee AS tx_payee, t.posted AS tx_posted FROM assets a
         LEFT JOIN entities e ON e.id = a.entity_id LEFT JOIN bank_transactions t ON t.id = a.transaction_id
         ${year ? "WHERE substr(a.placed_in_service, 1, 4) = ?" : ''} ORDER BY a.placed_in_service, a.id`
      )
      .all(...(year ? [String(year)] : [])) as Row[]).map(toAsset);

  function addAsset(input: {
    description?: string | null;
    cost?: number | null;
    placedInService?: string | null;
    entityId?: number | null;
    recovery?: string | null;
    transactionId?: number | null;
    itemKey?: string | null;
    note?: string | null;
  }) {
    // From a transaction, unspecified details come from it.
    const tx = input.transactionId ? bank.transactionById(input.transactionId) : null;
    if (input.transactionId && !tx) throw new Error('That transaction was not found.');
    const description = input.description || tx?.payee || tx?.description;
    const cost = input.cost ?? (tx ? Math.abs(tx.amount) : null);
    const date = input.placedInService || tx?.posted;
    if (!description || !cost || cost <= 0 || !date) throw new Error('An asset needs a description, a cost and the date it was placed in service.');
    try {
      return Number(
        raw
          .prepare(
            'INSERT INTO assets (description, cost, placed_in_service, entity_id, recovery, transaction_id, item_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(description.slice(0, 200), cents(cost), date, input.entityId ?? tx?.entity_id ?? null, input.recovery ?? null, input.transactionId ?? null, input.itemKey ?? null, input.note ?? null, now())
          .lastInsertRowid
      );
    } catch (err) {
      if (/UNIQUE/.test((err as Error).message)) throw new Error('That purchase is already on the asset register.');
      throw err;
    }
  }

  function updateAsset(id: number, input: { description?: string; cost?: number; placedInService?: string; entityId?: number | null; recovery?: string | null; note?: string | null }) {
    const row = raw.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    if (!row) return false;
    raw.prepare('UPDATE assets SET description = ?, cost = ?, placed_in_service = ?, entity_id = ?, recovery = ?, note = ? WHERE id = ?').run(
      input.description ?? row.description,
      input.cost !== undefined ? cents(input.cost) : row.cost,
      input.placedInService ?? row.placed_in_service,
      'entityId' in input ? input.entityId ?? null : row.entity_id,
      'recovery' in input ? input.recovery ?? null : row.recovery,
      'note' in input ? input.note ?? null : row.note,
      id
    );
    return true;
  }

  const deleteAsset = (id: number) => raw.prepare('DELETE FROM assets WHERE id = ?').run(id).changes > 0;

  /* ---------- The year's lines ---------- */

  function yearLines(year: number, entityId: number | 'none' | null = null): YearLine[] {
    const categories = new Map(db.categoryList().map((c) => [c.name, c]));
    const entities = new Map(correlate.entities().map((e) => [e.id, e]));
    const capital = new Set(
      (raw.prepare('SELECT transaction_id, item_key FROM assets WHERE transaction_id IS NOT NULL').all() as Row[]).map((r) => (r.item_key ? `item:${r.transaction_id}:${r.item_key}` : `tx:${r.transaction_id}`))
    );
    return correlate
      .spendLines({ years: [String(year)] })
      .filter((l) => entityId === null || (entityId === 'none' ? l.entityId === null : l.entityId === entityId))
      .map((l) => {
        const key = lineKey(l);
        const entity = l.entityId ? entities.get(l.entityId) : undefined;
        const form = formOf(entity);
        const category = categories.get(l.category);
        const isCapital = capital.has(key) || capital.has(`tx:${l.txId}`);
        const cls: ExpenseClass = l.status === 'personal' ? 'personal' : isCapital ? 'capex' : category?.expenseClass === 'cogs' ? 'cogs' : 'opex';
        return { ...l, class: cls, entity: entity?.name ?? null, form, line: (category ? category[FORM_KEYS[form] ?? 'scheduleC'] : null) ?? null, key };
      });
  }

  // Business purchases of $2,500 or more not yet on the asset register or set aside.
  function possibleCapital(year: number) {
    const reviewed = new Set((raw.prepare('SELECT key FROM capital_reviews').all() as Row[]).map((r) => r.key as string));
    const groups = new Map<string, { key: string; txId: number; posted: string; payee: string; item: string | null; category: string; amount: number }>();
    for (const l of yearLines(year)) {
      if (l.class !== 'opex' && l.class !== 'cogs') continue;
      if (reviewed.has(l.key)) continue;
      const g = groups.get(l.key) || { key: l.key, txId: l.txId, posted: l.posted, payee: l.payee, item: l.item?.name ?? null, category: l.category, amount: 0 };
      g.amount += l.amount;
      groups.set(l.key, g);
    }
    return [...groups.values()].filter((g) => g.amount >= DE_MINIMIS).map((g) => ({ ...g, amount: cents(g.amount) })).sort((a, b) => b.amount - a.amount);
  }

  const dismissCapital = (key: string) => raw.prepare('INSERT OR IGNORE INTO capital_reviews (key, decided_at) VALUES (?, ?)').run(key, now());

  // Puts a flagged purchase on the asset register.
  function confirmCapital(key: string, details: { recovery?: string | null; description?: string | null } = {}) {
    const match = key.match(/^(tx|item):(\d+)(?::(.*))?$/);
    if (!match) throw new Error('Unknown purchase.');
    const txId = Number(match[2]);
    const lines = yearLines(Number(String(bank.transactionById(txId)?.posted || '').slice(0, 4))).filter((l) => l.key === key);
    if (!lines.length) throw new Error('That purchase was not found.');
    const amount = lines.reduce((t, l) => t + l.amount, 0);
    return addAsset({
      transactionId: txId,
      itemKey: match[1] === 'item' ? match[3] : null,
      description: details.description || lines[0].item?.name || lines[0].payee,
      cost: amount,
      placedInService: lines[0].posted,
      entityId: lines[0].entityId,
      recovery: details.recovery ?? null,
    });
  }

  /* ---------- Income and transfers ---------- */

  function income(year: number, entityId: number | 'none' | null = null) {
    const names = new Map(correlate.entities().map((e) => [e.id, e.name]));
    return bank
      .listTransactions({ years: [String(year)], kind: 'normal', direction: 'in', entity: entityId === null ? null : [entityId] }, { sort: 'date', direction: 'asc' })
      .transactions.map((t) => ({ posted: t.posted, account: t.account, payee: t.payee || t.description, description: t.description, category: t.category || 'Uncategorized', entity: t.entityId ? names.get(t.entityId) ?? null : null, amount: t.amount }));
  }

  // Money moved between the owner's accounts. Business to personal is an owner draw;
  // personal to business, an owner contribution.
  function transfers(year: number) {
    const owners = new Map(bank.accounts().map((a) => [a.id, a]));
    return bank
      .listTransactions({ years: [String(year)], kind: 'transfer' }, { sort: 'date', direction: 'asc' })
      // Money out of each account, and money in that the owner put in (its other side may
      // not be in Business Hub).
      .transactions.filter((t) => t.amount < 0 || t.category === OWNER_CONTRIBUTION)
      .map((t) => {
        const from = owners.get(t.accountId);
        const partner = t.transferId ? bank.transactionById(t.transferId) : null;
        const to = partner ? owners.get(partner.account_id) : null;
        const kind =
          t.category === OWNER_WITHDRAWAL
            ? 'Owner draw'
            : t.category === OWNER_CONTRIBUTION
              ? 'Owner contribution'
              : from?.owner === 'business' && to?.owner === 'personal'
            ? 'Owner draw'
            : from?.owner === 'personal' && to?.owner === 'business'
              ? 'Owner contribution'
              : to
                ? 'Between accounts'
                : PAID_TO_CARD.test(t.description) || ACCOUNT_NUMBER_IN_PAYMENT.test(t.description)
                  ? 'Credit card payment'
                  : 'Payment or transfer to an account not in Business Hub';
        // Money in: it came from the owner, into this account.
        if (t.amount > 0) return { posted: t.posted, from: partner && to ? to.name : 'The owner', to: t.account, amount: t.amount, kind, description: t.description };
        return { posted: t.posted, from: t.account, to: to?.name ?? null, amount: -t.amount, kind, description: t.description };
      });
  }

  /* ---------- What still needs a decision ---------- */

  function review(year: number) {
    const lines = yearLines(year);
    const undecided = new Set(lines.filter((l) => !l.status).map((l) => l.txId));
    const uncategorised = new Set(lines.filter((l) => l.class !== 'personal' && (!l.category || l.category === 'Uncategorized')).map((l) => l.txId));
    const noEntity = correlate.entities().length ? new Set(lines.filter((l) => l.class !== 'personal' && !l.entityId).map((l) => l.txId)) : new Set<number>();
    const unmatched = bank.listTransactions({ years: [String(year)], storeUnlinked: true }, { limit: 1 }).total;
    const ordersWithoutCharge = bank.accounts().length
      ? ((raw
          .prepare(
            `SELECT COUNT(*) AS n FROM orders o WHERE substr(o.order_date, 1, 4) = ? AND o.total > 0
             AND NOT EXISTS (SELECT 1 FROM order_links l WHERE l.store = o.store AND l.order_id = o.order_id)`
          )
          .get(String(year)) as Row).n as number)
      : 0;
    return {
      undecided: undecided.size,
      uncategorised: uncategorised.size,
      noEntity: noEntity.size,
      possibleCapital: possibleCapital(year).length,
      unmatchedStoreCharges: unmatched,
      ordersWithoutCharge,
      receiptsToCheck: receipts.counts().review,
    };
  }

  /* ---------- Summary ---------- */

  // Per business or property: expenses by Schedule line and category, and totals
  // by class, with income alongside.
  function summary(year: number, entityId: number | 'none' | null = null) {
    type Group = {
      entityId: number | null;
      entity: string;
      form: string;
      lines: Map<string, number>;
      categories: Map<string, number>;
      totals: Record<ExpenseClass, number>;
      income: number;
    };
    const known = new Map(correlate.entities().map((e) => [e.id, e]));
    const groups = new Map<string, Group>();
    const groupFor = (id: number | null) => {
      const key = id === null ? 'none' : String(id);
      if (!groups.has(key)) {
        const entity = id === null ? undefined : known.get(id);
        groups.set(key, {
          entityId: id,
          entity: entity?.name ?? 'Not assigned',
          form: formOf(entity),
          lines: new Map(),
          categories: new Map(),
          totals: { opex: 0, cogs: 0, capex: 0, personal: 0 },
          income: 0,
        });
      }
      return groups.get(key)!;
    };
    for (const l of yearLines(year, entityId)) {
      const g = groupFor(l.entityId);
      g.totals[l.class] += l.amount;
      if (l.class === 'opex' || l.class === 'cogs') {
        g.lines.set(l.line ?? '', (g.lines.get(l.line ?? '') || 0) + l.amount);
        g.categories.set(l.category, (g.categories.get(l.category) || 0) + l.amount);
      }
    }
    const names = new Map([...known.values()].map((e) => [e.name, e.id]));
    for (const t of income(year, entityId)) groupFor(t.entity ? names.get(t.entity) ?? null : null).income += t.amount;
    return [...groups.values()]
      .map((g) => ({
        entityId: g.entityId,
        entity: g.entity,
        form: g.form,
        lines: [...g.lines.entries()]
          .map(([line, amount]) => ({ line: line || null, amount: cents(amount) }))
          .sort((a, b) => (a.line ?? 'zz').localeCompare(b.line ?? 'zz', undefined, { numeric: true })),
        categories: [...g.categories.entries()].map(([category, amount]) => ({ category, amount: cents(amount) })).sort((a, b) => b.amount - a.amount),
        opex: cents(g.totals.opex),
        cogs: cents(g.totals.cogs),
        capex: cents(g.totals.capex),
        personal: cents(g.totals.personal),
        income: cents(g.income),
      }))
      .sort((a, b) => (a.entityId === null ? 1 : b.entityId === null ? -1 : a.entity.localeCompare(b.entity)));
  }

  // The year's receipts, for the package.
  function yearReceipts(year: number) {
    return receipts
      .list({ from: `${year}-01-01`, to: `${year}-12-31` }, 100000, 0)
      .receipts.map((r) => ({ ...r, file: receipts.filePath(r.id) }));
  }

  return { assets, addAsset, updateAsset, deleteAsset, yearLines, possibleCapital, dismissCapital, confirmCapital, income, transfers, review, summary, yearReceipts };
}

export type CpaService = ReturnType<typeof cpaService>;

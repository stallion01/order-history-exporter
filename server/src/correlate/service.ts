// Phase 4: links store orders to the card charges that paid for them, splits each
// linked charge by the order's items, and keeps the businesses and properties
// ("entities") that spending belongs to.
import type { BankStore, OrderInfo, Share, TxFilters } from '../bank/store';
import { incomeSource, storeName } from '../bank/merchant';
import type { IncomeSource } from '../bank/merchant';
import { ORDER_STORE_PAYEES } from '../bank/store';
import { toCents } from '../bank/types';
import type { OrdersDb } from '../legacy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const DAY_MS = 86400000;
const BEFORE_ORDER_DAYS = 2; // a charge can post a little before the order date shows
const AFTER_ORDER_DAYS = 14; // stores charge when they ship
const MAX_SHIPMENTS = 4;
const STORES = Object.keys(ORDER_STORE_PAYEES);
export const ENTITY_KINDS = ['business', 'rental', 'other'] as const;
// What a business does: a short-term rental (active), a long-term rental (passive), or something else.
export const ENTITY_ACTIVITIES = ['str', 'ltr', 'other'] as const;
// The form its income and expenses go on.
export const ENTITY_TAX_FORMS = ['form-1065', 'form-8825', 'schedule-c', 'schedule-e'] as const;
export interface EntityInput {
  id?: number;
  name: string;
  kind: string;
  activity?: string | null;
  taxForm?: string | null;
  invested?: number | null;
  investedOn?: string | null;
}

const now = () => new Date().toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const orderKey = (store: string, orderId: string) => `${store}\u0000${orderId}`;
const cents = (n: number) => Math.round(n * 100) / 100;
const lastFour = (payment: string | null) => (String(payment || '').match(/(\d{4})(?!.*\d{4})/) || [])[1] ?? null;

export interface SpendLine {
  category: string;
  status: string | null;
  entityId: number | null;
  amount: number;
  // Where it came from: the transaction, and the order item when split by item.
  txId: number;
  posted: string;
  account: string;
  payee: string;
  description: string;
  receiptId: number | null;
  item: { store: string; orderId: string; name: string } | null;
  share: number; // percent of the line for this entity
}

type ItemLine = { category: string; status: string | null; amount: number; item: SpendLine['item'] };

// Charges (each a negative amount in cents, as a positive number) that add up to a
// total, smallest groups first. Stops once two answers are found: only a single
// answer is used automatically.
function shipmentSets<T extends Row>(pool: T[], total: number): T[][] {
  const found: T[][] = [];
  const values = pool.map((c) => -toCents(c.amount));
  for (let size = 2; size <= Math.min(MAX_SHIPMENTS, pool.length) && found.length < 2; size++) {
    const pick: number[] = [];
    const walk = (start: number, sum: number) => {
      if (found.length >= 2) return;
      if (pick.length === size) {
        if (sum === total) found.push(pick.map((i) => pool[i]));
        return;
      }
      for (let i = start; i < pool.length; i++) {
        if (sum + values[i] > total) continue;
        pick.push(i);
        walk(i + 1, sum + values[i]);
        pick.pop();
      }
    };
    walk(0, 0);
  }
  return found;
}

export function correlationService({ db, bank }: { db: OrdersDb; bank: BankStore }) {
  const raw = db.raw;

  /* ---------- Entities ---------- */

  const entities = () =>
    (raw.prepare('SELECT id, name, kind, activity, tax_form, invested, invested_on FROM entities ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      kind: r.kind as string,
      activity: (r.activity as string | null) ?? (r.kind === 'rental' ? 'ltr' : 'other'),
      taxForm: (r.tax_form as string | null) ?? (r.kind === 'rental' ? 'schedule-e' : 'schedule-c'),
      invested: (r.invested as number | null) ?? null,
      investedOn: (r.invested_on as string | null) ?? null,
    }));

  // Fields left out keep what they were.
  function saveEntity(input: EntityInput) {
    const keep = <T,>(value: T | undefined, before: T | null) => (value === undefined ? before : value);
    if (input.id) {
      const before = raw.prepare('SELECT activity, tax_form, invested, invested_on FROM entities WHERE id = ?').get(input.id) as Row;
      raw
        .prepare('UPDATE entities SET name = ?, kind = ?, activity = ?, tax_form = ?, invested = ?, invested_on = ? WHERE id = ?')
        .run(
          input.name,
          input.kind,
          keep(input.activity, before.activity) ?? null,
          keep(input.taxForm, before.tax_form) ?? null,
          keep(input.invested, before.invested) ?? null,
          keep(input.investedOn, before.invested_on) ?? null,
          input.id
        );
      return input.id;
    }
    return Number(
      raw
        .prepare('INSERT INTO entities (name, kind, activity, tax_form, invested, invested_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          input.name,
          input.kind,
          input.activity ?? (input.kind === 'rental' ? 'ltr' : 'other'),
          input.taxForm ?? (input.kind === 'rental' ? 'schedule-e' : 'schedule-c'),
          input.invested ?? null,
          input.investedOn ?? null,
          now()
        ).lastInsertRowid
    );
  }

  function deleteEntity(id: number) {
    const removed = raw.prepare('DELETE FROM entities WHERE id = ?').run(id).changes > 0;
    // Rules that only shared between entities drop the removed one.
    for (const rule of raw.prepare('SELECT id, shared_entities FROM bank_rules WHERE shared_entities IS NOT NULL').all() as Row[]) {
      const left = (JSON.parse(rule.shared_entities) as number[]).filter((e) => e !== id);
      raw.prepare('UPDATE bank_rules SET shared_entities = ?, entity_id = ? WHERE id = ?').run(left.length > 1 ? JSON.stringify(left) : null, left.length === 1 ? left[0] : null, rule.id);
    }
    if (removed) bank.applyRules();
    return removed;
  }

  const placeEntities = () => new Map((raw.prepare('SELECT zip, entity_id FROM place_entities').all() as Row[]).map((r) => [r.zip as string, r.entity_id as number]));

  function setPlaceEntity(zip: string, entityId: number | null) {
    if (entityId) raw.prepare('INSERT INTO place_entities (zip, entity_id) VALUES (?, ?) ON CONFLICT (zip) DO UPDATE SET entity_id = excluded.entity_id').run(zip, entityId);
    else raw.prepare('DELETE FROM place_entities WHERE zip = ?').run(zip);
    refreshLinked();
  }

  /* ---------- Orders and their items ---------- */

  // Each order's items with their share of its total, category and status.
  function itemsFor(keys: Set<string>) {
    const out = new Map<string, Row[]>();
    if (!keys.size) return out;
    for (const item of db.enrichedItems({}) as Row[]) {
      const key = orderKey(item.store, item.orderId);
      if (!keys.has(key)) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(item);
    }
    return out;
  }

  const linksFor = (ids: number[]) =>
    ids.length
      ? (raw
          .prepare(
            `SELECT l.transaction_id, l.store, l.order_id, l.amount, o.total, o.delivery_zip FROM order_links l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
             WHERE l.transaction_id IN (${ids.map(Number).filter(Number.isInteger).join(',')})`
          )
          .all() as Row[])
      : [];

  // A linked charge's spending, item by item: each item's share of the order,
  // scaled to the part of the charge that paid for that order.
  function itemLines(links: Row[], items: Map<string, Row[]>) {
    const lines: ItemLine[] = [];
    let covered = 0;
    for (const link of links) {
      const own = items.get(orderKey(link.store, link.order_id)) || [];
      const sum = own.reduce((t, i) => t + (typeof i.amount === 'number' ? i.amount : 0), 0);
      covered += link.amount;
      if (sum <= 0) {
        lines.push({ category: '', status: null, amount: link.amount, item: null });
        continue;
      }
      for (const item of own) {
        if (typeof item.amount !== 'number' || !item.amount) continue;
        lines.push({
          category: item.category,
          status: item.status === 'business' || item.status === 'personal' ? item.status : null,
          amount: (item.amount / sum) * link.amount,
          item: { store: link.store, orderId: link.order_id, name: item.name },
        });
      }
    }
    return { lines, covered };
  }

  // What linked orders say about each transaction: its main category and delivery places.
  function orderInfo(ids: number[]): Map<number, OrderInfo> {
    const links = linksFor(ids);
    const out = new Map<number, OrderInfo>();
    if (!links.length) return out;
    const items = itemsFor(new Set(links.map((l) => orderKey(l.store, l.order_id))));
    const byTx = new Map<number, Row[]>();
    for (const link of links) {
      if (!byTx.has(link.transaction_id)) byTx.set(link.transaction_id, []);
      byTx.get(link.transaction_id)!.push(link);
    }
    for (const [txId, own] of byTx) {
      const totals = new Map<string, number>();
      for (const line of itemLines(own, items).lines) if (line.category) totals.set(line.category, (totals.get(line.category) || 0) + line.amount);
      const category = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      out.set(txId, { category, zips: [...new Set(own.map((l) => l.delivery_zip).filter(Boolean))] as string[] });
    }
    return out;
  }
  bank.setOrderInfo(orderInfo);

  // After item categories, places or entities change, linked charges follow.
  const refreshLinked = () => bank.applyRules('t.id IN (SELECT transaction_id FROM order_links) OR t.entity_source = \'place\'');

  /* ---------- Matching ---------- */

  function link(txId: number, store: string, orderId: string, source: 'auto' | 'user', amount?: number) {
    const tx = bank.transactionById(txId);
    if (!tx) throw new Error('That transaction was not found.');
    const order = raw.prepare('SELECT total FROM orders WHERE store = ? AND order_id = ?').get(store, orderId) as Row | undefined;
    if (!order) throw new Error('That order was not found.');
    // Without an amount, the part of the charge not already paying for other orders.
    const already = (raw.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM order_links WHERE transaction_id = ? AND NOT (store = ? AND order_id = ?)').get(txId, store, orderId) as Row).n as number;
    const charge = Math.abs(tx.amount as number);
    const part = cents(amount ?? Math.max(0.01, charge - already));
    raw.prepare(
      `INSERT INTO order_links (transaction_id, store, order_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (transaction_id, store, order_id) DO UPDATE SET amount = excluded.amount, source = excluded.source`
    ).run(txId, store, orderId, part, source, now());
    raw.prepare('DELETE FROM order_link_rejections WHERE transaction_id = ? AND store = ? AND order_id = ?').run(txId, store, orderId);
  }

  function linkByUser(txId: number, store: string, orderId: string) {
    link(txId, store, orderId, 'user');
    bank.applyRules(`t.id = ${Number(txId)}`);
  }

  function unlink(txId: number, store: string, orderId: string) {
    const removed = raw.prepare('DELETE FROM order_links WHERE transaction_id = ? AND store = ? AND order_id = ?').run(txId, store, orderId).changes > 0;
    raw.prepare('INSERT OR IGNORE INTO order_link_rejections (transaction_id, store, order_id) VALUES (?, ?, ?)').run(txId, store, orderId);
    bank.applyRules(`t.id = ${Number(txId)}`);
    return removed;
  }

  // Links each store order to its card charge, or to the charges for its shipments,
  // when only one answer fits. Returns how many charges were linked.
  function matchOrders(): number {
    const payees = [...new Set(Object.values(ORDER_STORE_PAYEES).flat())];
    const charges = raw
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.payee, a.last4 FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.amount < 0 AND t.kind != 'transfer' AND t.payee IN (${payees.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM order_links l WHERE l.transaction_id = t.id)
         ORDER BY t.posted, t.id`
      )
      .all(...payees) as Row[];
    if (!charges.length) return 0;
    const earliest = charges[0].posted as string;
    const orders = raw
      .prepare(
        `SELECT store, order_id, order_date, total, payment FROM orders o
         WHERE total > 0 AND order_date >= ? AND store IN (${STORES.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM order_links l WHERE l.store = o.store AND l.order_id = o.order_id)
         ORDER BY order_date, order_id`
      )
      .all(new Date((dayNumber(earliest) - AFTER_ORDER_DAYS) * DAY_MS).toISOString().slice(0, 10), ...STORES) as Row[];
    const rejected = new Set((raw.prepare('SELECT transaction_id, store, order_id FROM order_link_rejections').all() as Row[]).map((r) => `${r.transaction_id}|${r.store}|${r.order_id}`));
    const used = new Set<number>();
    const linked: number[] = [];

    const taken = new Set<string>();
    const orderKeyOf = (o: Row) => `${o.store}|${o.order_id}`;
    const window = (charge: Row, order: Row) => {
      const offset = dayNumber(charge.posted) - dayNumber(order.order_date);
      return offset >= -BEFORE_ORDER_DAYS && offset <= AFTER_ORDER_DAYS;
    };
    // Is this order clearly the one for this charge? Not if another open order for the
    // same amount at the same store is as close (or closer) in date: then two orders
    // could be it, and the user decides.
    const clearlyThis = (charge: Row, order: Row) => {
      const mine = Math.abs(dayNumber(charge.posted) - dayNumber(order.order_date));
      return !orders.some(
        (o) =>
          o !== order &&
          !taken.has(orderKeyOf(o)) &&
          o.store === order.store &&
          toCents(o.total) === toCents(order.total) &&
          window(charge, o) &&
          !rejected.has(`${charge.id}|${o.store}|${o.order_id}`) &&
          Math.abs(dayNumber(charge.posted) - dayNumber(o.order_date)) <= mine
      );
    };

    // A second pass settles pairs: two equal orders and two equal charges, once the
    // closer of each has been linked.
    for (let pass = 0; pass < 3; pass++) {
      let progress = false;
      for (const order of orders) {
        if (taken.has(orderKeyOf(order))) continue;
        const day = dayNumber(order.order_date);
        const card = lastFour(order.payment);
        const total = toCents(order.total);
        const fits = charges.filter(
          (c) =>
            !used.has(c.id) &&
            ORDER_STORE_PAYEES[order.store].includes(c.payee) &&
            window(c, order) &&
            !rejected.has(`${c.id}|${order.store}|${order.order_id}`) &&
            // A different card than the order says was used can't be it.
            !(card && c.last4 && c.last4 !== card)
        );
        let chosen: Row[] | null = null;
        const exact = fits.filter((c) => -toCents(c.amount) === total);
        if (exact.length === 1) chosen = exact;
        else if (exact.length > 1) {
          const sameCard = exact.filter((c) => card && c.last4 === card);
          if (sameCard.length === 1) chosen = sameCard;
          else {
            const byDate = [...exact].sort((a, b) => Math.abs(dayNumber(a.posted) - day) - Math.abs(dayNumber(b.posted) - day));
            if (Math.abs(dayNumber(byDate[0].posted) - day) < Math.abs(dayNumber(byDate[1].posted) - day)) chosen = [byDate[0]];
          }
        } else {
          // Charged in parts, one per shipment.
          const pool = fits.filter((c) => -toCents(c.amount) < total).slice(0, 12);
          const sets = shipmentSets(pool, total);
          if (sets.length === 1) chosen = sets[0];
        }
        if (!chosen) continue;
        if (chosen.length === 1 && !clearlyThis(chosen[0], order)) continue;
        for (const c of chosen) {
          link(c.id, order.store, order.order_id, 'auto', Math.abs(c.amount));
          used.add(c.id);
          linked.push(c.id);
        }
        taken.add(orderKeyOf(order));
        progress = true;
      }
      if (!progress) break;
    }
    if (linked.length) bank.applyRules(`t.id IN (${linked.join(',')})`);
    return linked.length;
  }

  // Orders a charge might be for, best first, with the ones already linked.
  function orderSuggestions(txId: number, q: string | null = null) {
    const tx = bank.transactionById(txId);
    if (!tx) return null;
    const stores = Object.entries(ORDER_STORE_PAYEES)
      .filter(([, names]) => names.includes(tx.payee))
      .map(([store]) => store);
    const day = dayNumber(tx.posted);
    const params: (string | number)[] = [];
    let where = '';
    if (q) {
      where = 'o.order_id LIKE ? OR EXISTS (SELECT 1 FROM items i WHERE i.store = o.store AND i.order_id = o.order_id AND i.name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    } else {
      where = `o.order_date BETWEEN ? AND ?${stores.length ? ` AND o.store IN (${stores.map(() => '?').join(', ')})` : ''}`;
      params.push(new Date((day - 30) * DAY_MS).toISOString().slice(0, 10), new Date((day + BEFORE_ORDER_DAYS) * DAY_MS).toISOString().slice(0, 10), ...stores);
    }
    const rows = raw
      .prepare(
        `SELECT o.store, COALESCE(o.store_name, o.store) AS store_name, o.order_id, o.order_date, o.total, o.payment,
                (SELECT GROUP_CONCAT(name, '; ') FROM (SELECT name FROM items i WHERE i.store = o.store AND i.order_id = o.order_id ORDER BY position LIMIT 3)) AS item_names,
                (SELECT COALESCE(SUM(l.amount), 0) FROM order_links l WHERE l.store = o.store AND l.order_id = o.order_id AND l.transaction_id != ?) AS paid_elsewhere
         FROM orders o WHERE ${where} ORDER BY o.order_date DESC LIMIT 40`
      )
      .all(txId, ...params) as Row[];
    const linked = new Set((raw.prepare('SELECT store, order_id FROM order_links WHERE transaction_id = ?').all(txId) as Row[]).map((r) => orderKey(r.store, r.order_id)));
    const charge = toCents(Math.abs(tx.amount));
    return rows
      .map((o) => ({
        store: o.store as string,
        storeName: o.store_name as string,
        orderId: o.order_id as string,
        date: o.order_date as string | null,
        total: o.total as number | null,
        items: o.item_names as string | null,
        paidElsewhere: cents(o.paid_elsewhere),
        linked: linked.has(orderKey(o.store, o.order_id)),
        exact: o.total !== null && toCents(o.total) === charge,
        days: o.order_date ? day - dayNumber(o.order_date) : null,
      }))
      .sort((a, b) => Number(b.linked) - Number(a.linked) || Number(b.exact) - Number(a.exact) || Math.abs(a.days ?? 99) - Math.abs(b.days ?? 99));
  }

  // The charges an order was paid with.
  const chargesFor = (store: string, orderId: string) =>
    (raw
      .prepare(
        `SELECT t.id, t.posted, t.amount, l.amount AS part, l.source, a.name AS account FROM order_links l
         JOIN bank_transactions t ON t.id = l.transaction_id JOIN bank_accounts a ON a.id = t.account_id
         WHERE l.store = ? AND l.order_id = ? ORDER BY t.posted`
      )
      .all(store, orderId) as Row[]).map((r) => ({ id: r.id, posted: r.posted, amount: r.amount, part: r.part, source: r.source, account: r.account }));

  /* ---------- Spending, split by item and entity ---------- */

  // Each money-out transaction as lines of category, business or personal, entity and amount.
  function spendLines(filters: TxFilters): SpendLine[] {
    const { transactions } = bank.listTransactions({ ...filters, kind: 'normal', direction: 'out' });
    const ids = transactions.map((t) => t.id);
    const links = linksFor(ids);
    const items = itemsFor(new Set(links.map((l) => orderKey(l.store, l.order_id))));
    const byTx = new Map<number, Row[]>();
    for (const link of links) {
      if (!byTx.has(link.transaction_id)) byTx.set(link.transaction_id, []);
      byTx.get(link.transaction_id)!.push(link);
    }
    const out: SpendLine[] = [];
    for (const tx of transactions) {
      const amount = -tx.amount;
      let lines: ItemLine[];
      const own = byTx.get(tx.id);
      // A category the user chose for the whole charge wins over the order's items.
      if (own && tx.categorySource !== 'user') {
        const split = itemLines(own, items);
        lines = split.lines.map((l) => ({ ...l, category: l.category || tx.category || 'Uncategorized', status: l.status ?? tx.status }));
        const rest = amount - split.covered;
        if (rest > 0.004) lines.push({ category: tx.category || 'Uncategorized', status: tx.status, amount: rest, item: null });
      } else {
        lines = [{ category: tx.category || 'Uncategorized', status: tx.status, amount, item: null }];
      }
      const shares: Share[] = tx.shares.length ? tx.shares : [{ entityId: tx.entityId as number, percent: 100 }];
      const about = { txId: tx.id, posted: tx.posted, account: tx.account, payee: tx.payee || tx.description, description: tx.description, receiptId: tx.receiptId };
      for (const line of lines) {
        for (const share of shares) out.push({ ...line, ...about, entityId: share.entityId ?? null, share: share.percent, amount: (line.amount * share.percent) / 100 });
      }
    }
    return out;
  }

  // Spending for a period: totals, and by category, entity and business or personal.
  // Leaving out personal goes by each line, so a business charge's personal items go too.
  function spending(filters: TxFilters) {
    const hidePersonal = filters.status === 'notpersonal';
    const all = spendLines(hidePersonal ? { ...filters, status: null } : filters);
    const lines = hidePersonal ? all.filter((l) => l.status !== 'personal') : all;
    const names = new Map(entities().map((e) => [e.id, e.name]));
    const group = (keyOf: (l: SpendLine) => string, labelOf: (key: string) => string) => {
      const map = new Map<string, number>();
      for (const line of lines) map.set(keyOf(line), (map.get(keyOf(line)) || 0) + line.amount);
      return [...map.entries()].map(([key, spend]) => ({ key, label: labelOf(key), spend: cents(spend) })).sort((a, b) => b.spend - a.spend);
    };
    const sum = (pick: (l: SpendLine) => boolean) => cents(lines.filter(pick).reduce((t, l) => t + l.amount, 0));
    return {
      totals: { spend: sum(() => true), business: sum((l) => l.status === 'business'), personal: sum((l) => l.status === 'personal'), undecided: sum((l) => !l.status) },
      byCategory: group((l) => l.category, (k) => k),
      byEntity: group((l) => (l.entityId ? String(l.entityId) : 'none'), (k) => (k === 'none' ? 'Not assigned' : names.get(Number(k)) || 'Removed')),
      byMonth: monthly(filters, lines),
      byStore: byStore(lines),
    };
  }

  // Spending by store or payee, from every account (not only the stores the extension
  // syncs), net of refunds. Spellings of one store are added together under the name
  // used most often.
  function byStore(lines: SpendLine[]) {
    const groups = new Map<string, { names: Map<string, number>; key: string; spend: number }>();
    for (const line of lines) {
      const { key, label } = storeName(line.payee);
      const id = key.toLowerCase();
      const g = groups.get(id) || { names: new Map<string, number>(), key, spend: 0 };
      g.names.set(label, (g.names.get(label) || 0) + 1);
      g.spend += line.amount;
      groups.set(id, g);
    }
    return [...groups.values()]
      .map((g) => ({ key: g.key, label: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0], spend: cents(g.spend) }))
      .filter((g) => g.spend !== 0)
      .sort((a, b) => b.spend - a.spend);
  }

  // Spending (less refunds) and income for each month, oldest first, with income split
  // by where it came from. Transfers are in neither.
  function monthly(filters: TxFilters, lines: SpendLine[]) {
    type Month = { month: string; spend: number; income: number; sources: Record<IncomeSource, number> };
    const months = new Map<string, Month>();
    const at = (month: string) =>
      months.get(month) || months.set(month, { month, spend: 0, income: 0, sources: { airbnb: 0, vrbo: 0, booking: 0, lease: 0, other: 0 } }).get(month)!;
    for (const line of lines) at(line.posted.slice(0, 7)).spend += line.amount;
    for (const tx of bank.listTransactions({ ...filters, kind: 'normal', direction: 'in' }).transactions) {
      const m = at(tx.posted.slice(0, 7));
      m.income += tx.amount;
      m.sources[incomeSource(`${tx.payee || ''} ${tx.description}`)] += tx.amount;
    }
    return [...months.values()]
      .map((m) => ({
        ...m,
        spend: cents(m.spend),
        income: cents(m.income),
        sources: Object.fromEntries(Object.entries(m.sources).map(([k, v]) => [k, cents(v)])) as Record<IncomeSource, number>,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  // A transaction's split, for showing it.
  function splitOf(txId: number) {
    const tx = bank.transactionById(txId);
    if (!tx) return null;
    const own = linksFor([txId]);
    if (!own.length) return [];
    const items = itemsFor(new Set(own.map((l) => orderKey(l.store, l.order_id))));
    const totals = new Map<string, { category: string; status: string | null; amount: number }>();
    const split = itemLines(own, items);
    for (const line of split.lines) {
      const category = line.category || tx.category || 'Uncategorized';
      const status = line.status ?? tx.status ?? null;
      const key = `${category}\u0000${status}`;
      const entry = totals.get(key) || { category, status, amount: 0 };
      entry.amount += line.amount;
      totals.set(key, entry);
    }
    const rest = Math.abs(tx.amount) - split.covered;
    const out = [...totals.values()].map((l) => ({ ...l, amount: cents(l.amount) }));
    if (rest > 0.004) out.push({ category: tx.category || 'Uncategorized', status: tx.status ?? null, amount: cents(rest) });
    return out.sort((a, b) => b.amount - a.amount);
  }

  return {
    entities,
    saveEntity,
    deleteEntity,
    placeEntities,
    setPlaceEntity,
    matchOrders,
    linkByUser,
    unlink,
    orderSuggestions,
    chargesFor,
    spending,
    spendLines,
    splitOf,
    refreshLinked,
  };
}

export type CorrelationService = ReturnType<typeof correlationService>;

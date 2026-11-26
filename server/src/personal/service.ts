// Personal money, month by month or a year at a time: what came in, where it went, what was
// only moved between their own pots, budgets for each kind of spending, and a look
// ahead built from regular paychecks and bills, budgets and typical months.
//
// Personal transactions are the ones marked personal (every transaction in a personal
// account, and those picked out as personal in a shared one). Transfers and ignored
// rows are left out, as everywhere else.
import type { DatabaseSync } from 'node:sqlite';
import { INCOME_GROUPS, MOVE_GROUPS, SPENDING_GROUPS, businessPattern, classify, seriesKey } from './groups';
import type { Flow, Group, SpendingGroup } from './groups';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Tx {
  id: number;
  posted: string;
  month: string;
  day: number;
  amount: number;
  description: string;
  payee: string | null;
  category: string | null;
  accountId: number;
  account: string;
  flow: Flow;
  group: Group;
  guessed: boolean;
  series: string;
  // Money sent to or from another family member: who, and the category given to it.
  family: { pairId: number; other: string; labelId: number | null; label: string | null } | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const monthOf = (date: string) => date.slice(0, 7);
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
};
// A readable payee: the bank's cleaned-up name, or the description's first words.
// Bank reference tails ("PPD ID: 123", "Conf# 9") are dropped, and a payment to or from
// a person is named after them rather than the app that carried it.
const titleCase = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const nameOf = (t: { payee: string | null; description: string; family?: Tx['family'] }) => {
  if (t.family) {
    const who = t.family.other;
    return t.family.label ? `${t.family.label} (${who})` : who;
  }
  const person = seriesKey(t.description, t.payee);
  if (person.startsWith('person ')) return titleCase(person.slice(7));
  const raw = t.payee && t.payee.length > 2 ? t.payee : t.description.split(/\s+/).slice(0, 4).join(' ');
  return raw.replace(/\s+\b(des|id|indn|ppd|ccd|web|entry|descr|conf|ref|confirmation)\b[:#]?.*$/i, '').trim() || raw;
};

export interface SummaryOptions {
  // One month (2026-11), or a whole year (2026) in its place.
  month?: string | null;
  year?: string | null;
  // Some of the person's accounts only; others are ignored.
  accounts?: number[] | null;
  // Whose money: a family member's id, or null for the owner's own.
  person?: number | null;
}

// A group a person chose for a payment, with which way the money went: one of the usual
// ones, or one of their own (spending).
function chosenGroup(group: string | null | undefined, custom: readonly string[] = []): { flow: Flow; group: Group; guessed: boolean } | null {
  if (!group) return null;
  if ((SPENDING_GROUPS as readonly string[]).includes(group) || custom.includes(group)) return { flow: 'out', group: group as Group, guessed: false };
  if ((INCOME_GROUPS as readonly string[]).includes(group)) return { flow: 'in', group: group as Group, guessed: false };
  return null;
}
// The most groups of their own a person can make.
const MAX_CUSTOM = 20;

export function personalService({ db, today = () => new Date().toISOString().slice(0, 10) }: { db: DatabaseSync; today?: () => string }) {
  function load(accountIds: number[], person: number | null = null): Tx[] {
    if (!accountIds.length) return [];
    const custom = customKeys(person);
    // The places this person always puts in one group.
    const rules = new Map((db.prepare('SELECT match, group_key FROM personal_group_rules WHERE person_id = ?').all(person ?? 0) as Row[]).map((r) => [String(r.match), String(r.group_key)]));
    // Transfers to the owner's business accounts are money moved, not spent.
    const business = businessPattern(
      (db.prepare("SELECT last4 FROM bank_accounts WHERE last4 IS NOT NULL AND (owner != 'personal' OR entity_id IS NOT NULL)").all() as Row[]).map((r) => String(r.last4)),
    );
    const income = new Set((db.prepare("SELECT name FROM categories WHERE expense_class = 'income'").all() as Row[]).map((r) => String(r.name)));
    const rows = db
      .prepare(
        // Transfers count only between two people's accounts: money one family member
        // sent another. Between one person's own accounts they're still left out.
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, t.category, t.account_id, a.name AS account, t.kind,
                p.id AS pair_id, pa.name AS other_account, pp.name AS other_person, pa.person_id AS other_person_id,
                t.family_label_id, l.name AS label, l.group_key AS label_group, t.personal_group
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         LEFT JOIN bank_transactions p ON p.id = t.transfer_id
         LEFT JOIN bank_accounts pa ON pa.id = p.account_id
         LEFT JOIN personal_people pp ON pp.id = pa.person_id
         LEFT JOIN personal_labels l ON l.id = t.family_label_id
         WHERE t.status = 'personal' AND t.amount != 0 AND t.account_id IN (${accountIds.map(Number).join(',')})
           AND (t.kind = 'normal' OR (t.kind = 'transfer' AND p.id IS NOT NULL AND pa.owner != 'business' AND pa.person_id IS NOT a.person_id))
         ORDER BY t.posted, t.id`,
      )
      .all() as Row[];
    return rows.map((r) => {
      const family =
        r.kind === 'transfer'
          ? {
              pairId: Number(r.pair_id),
              // The other side: a family member by name, or the owner's account by its name.
              other: `${r.amount < 0 ? 'To' : 'From'} ${r.other_person ?? r.other_account}`,
              labelId: r.family_label_id == null ? null : Number(r.family_label_id),
              label: r.label ?? null,
            }
          : null;
      const c = family
        ? r.amount < 0
          ? { flow: 'out' as const, group: ((SPENDING_GROUPS as readonly string[]).includes(r.label_group) ? r.label_group : 'family') as Group, guessed: false }
          : { flow: 'in' as const, group: 'family_in' as Group, guessed: false }
        : (chosenGroup(r.personal_group, custom) ??
          chosenGroup(rules.get(seriesKey(r.description, r.payee)), custom) ??
          classify({ amount: r.amount, description: r.description, payee: r.payee, category: r.category }, business, income));
      return {
        id: r.id,
        posted: r.posted,
        month: monthOf(r.posted),
        day: Number(String(r.posted).slice(8, 10)),
        amount: r.amount,
        description: r.description,
        payee: r.payee ?? null,
        category: r.category ?? null,
        accountId: r.account_id,
        account: r.account,
        flow: c.flow,
        group: c.group,
        guessed: c.guessed,
        series: family ? `${c.flow}:family ${family.other} ${family.label ?? ''}` : `${c.flow}:${seriesKey(r.description, r.payee)}`,
        family,
      };
    });
  }

  // Budgets are each person's own; the owner's are person 0.
  const budgets = (person: number | null = null): Record<string, number> =>
    Object.fromEntries((db.prepare('SELECT group_key, monthly FROM personal_budgets WHERE person_id = ?').all(person ?? 0) as Row[]).map((r) => [r.group_key, r.monthly]));

  function setBudget(person: number | null, group: string, monthly: number | null) {
    if (!(SPENDING_GROUPS as readonly string[]).includes(group) && !customKeys(person).includes(group)) throw new Error('That is not a kind of spending.');
    if (person !== null && !db.prepare('SELECT 1 FROM personal_people WHERE id = ?').get(person)) throw new Error('That person is not here.');
    if (monthly === null || monthly <= 0) db.prepare('DELETE FROM personal_budgets WHERE person_id = ? AND group_key = ?').run(person ?? 0, group);
    else
      db.prepare(
        'INSERT INTO personal_budgets (person_id, group_key, monthly, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, group_key) DO UPDATE SET monthly = excluded.monthly, updated_at = excluded.updated_at',
      ).run(person ?? 0, group, cents(monthly), new Date().toISOString());
    return budgets(person);
  }

  // The owner's categories for money sent between family, each counted as a kind of spending.
  const labels = () =>
    (db.prepare('SELECT id, name, group_key FROM personal_labels ORDER BY name COLLATE NOCASE').all() as Row[]).map((l) => ({ id: Number(l.id), name: String(l.name), group: String(l.group_key) }));

  function addLabel(name: string, group: string) {
    if (!(SPENDING_GROUPS as readonly string[]).includes(group)) throw new Error('That is not a kind of spending.');
    if (db.prepare('SELECT 1 FROM personal_labels WHERE name = ?').get(name)) throw new Error('There is already a category with that name.');
    const result = db.prepare('INSERT INTO personal_labels (name, group_key, created_at) VALUES (?, ?, ?)').run(name, group, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  // A person sorting one of their own payments for their budget: a kind of spending or
  // of money in, or null to go back to the bank's description and the category. Only
  // their own accounts' payments, and never a transfer between family.
  // With everyTime, the group goes on every payment from the same place, now and later.
  function setGroup(person: number | null, transactionId: number, group: string | null, everyTime = false) {
    if (group !== null && !chosenGroup(group, customKeys(person))) throw new Error('That is not a kind of spending or income.');
    const row = db
      .prepare("SELECT t.id, t.kind, t.description, t.payee FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id WHERE t.id = ? AND t.status = 'personal' AND a.person_id IS ?")
      .get(transactionId, person) as Row | undefined;
    if (!row) throw new Error('That payment is not one of yours.');
    if (row.kind !== 'normal') throw new Error('Money moved between accounts is sorted on its own.');
    if (!everyTime) {
      db.prepare('UPDATE bank_transactions SET personal_group = ? WHERE id = ?').run(group, transactionId);
      return;
    }
    const match = seriesKey(String(row.description), row.payee ?? null);
    const label = nameOf({ payee: row.payee ?? null, description: String(row.description) });
    if (group === null) db.prepare('DELETE FROM personal_group_rules WHERE person_id = ? AND match = ?').run(person ?? 0, match);
    else
      db.prepare(
        'INSERT INTO personal_group_rules (person_id, match, label, group_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (person_id, match) DO UPDATE SET group_key = excluded.group_key, label = excluded.label',
      ).run(person ?? 0, match, label, group, new Date().toISOString());
    // The rule decides from now on, so this payment's own choice goes.
    db.prepare('UPDATE bank_transactions SET personal_group = NULL WHERE id = ?').run(transactionId);
  }

  // Many of a person's own payments into one group at once: all of them or, if any
  // isn't theirs, none.
  function setGroups(person: number | null, transactionIds: number[], group: string | null) {
    db.exec('BEGIN');
    try {
      for (const id of transactionIds) setGroup(person, id, group);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return transactionIds.length;
  }

  // A person's own groups, made beside the usual ones.
  const customGroups = (person: number | null) =>
    (db.prepare('SELECT id, name FROM personal_custom_groups WHERE person_id = ? ORDER BY id').all(person ?? 0) as Row[]).map((r) => ({ key: `c${r.id}`, name: String(r.name) }));
  function customKeys(person: number | null) {
    return customGroups(person).map((g) => g.key);
  }
  function addCustomGroup(person: number | null, name: string) {
    const mine = customGroups(person);
    if (mine.length >= MAX_CUSTOM) throw new Error(`Up to ${MAX_CUSTOM} groups of your own.`);
    if (mine.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new Error('You already have a group with that name.');
    const result = db.prepare('INSERT INTO personal_custom_groups (person_id, name, created_at) VALUES (?, ?, ?)').run(person ?? 0, name, new Date().toISOString());
    return `c${result.lastInsertRowid}`;
  }
  // A group of their own goes: its payments go back to where they'd otherwise be, and
  // its places, budget and name go with it.
  function removeCustomGroup(person: number | null, key: string) {
    if (!customKeys(person).includes(key)) throw new Error('That is not one of your groups.');
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE bank_transactions SET personal_group = NULL WHERE personal_group = ?').run(key);
      db.prepare('DELETE FROM personal_group_rules WHERE person_id = ? AND group_key = ?').run(person ?? 0, key);
      db.prepare('DELETE FROM personal_budgets WHERE person_id = ? AND group_key = ?').run(person ?? 0, key);
      db.prepare('DELETE FROM personal_group_names WHERE person_id = ? AND group_key = ?').run(person ?? 0, key);
      db.prepare('DELETE FROM personal_custom_groups WHERE id = ? AND person_id = ?').run(Number(key.slice(1)), person ?? 0);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // A person's places that always go in one group.
  const groupRules = (person: number | null) =>
    (db.prepare('SELECT id, label, group_key FROM personal_group_rules WHERE person_id = ? ORDER BY label COLLATE NOCASE').all(person ?? 0) as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.label),
      group: String(r.group_key),
    }));
  function removeGroupRule(person: number | null, id: number) {
    const result = db.prepare('DELETE FROM personal_group_rules WHERE id = ? AND person_id = ?').run(id, person ?? 0);
    if (!result.changes) throw new Error('That is not one of yours.');
  }

  // A person's own names for the kinds of money; null puts the usual name back.
  const groupNames = (person: number | null): Record<string, string> => ({
    ...Object.fromEntries((db.prepare('SELECT group_key, name FROM personal_group_names WHERE person_id = ?').all(person ?? 0) as Row[]).map((r) => [String(r.group_key), String(r.name)])),
    ...Object.fromEntries(customGroups(person).map((g) => [g.key, g.name])),
  });
  function renameGroup(person: number | null, group: string, name: string | null) {
    if (customKeys(person).includes(group)) {
      if (name === null) throw new Error('A group of your own needs a name.');
      db.prepare('UPDATE personal_custom_groups SET name = ? WHERE id = ? AND person_id = ?').run(name, Number(group.slice(1)), person ?? 0);
      return groupNames(person);
    }
    if (!chosenGroup(group)) throw new Error('That is not a kind of spending or income.');
    if (name === null) db.prepare('DELETE FROM personal_group_names WHERE person_id = ? AND group_key = ?').run(person ?? 0, group);
    else
      db.prepare('INSERT INTO personal_group_names (person_id, group_key, name) VALUES (?, ?, ?) ON CONFLICT (person_id, group_key) DO UPDATE SET name = excluded.name').run(person ?? 0, group, name);
    return groupNames(person);
  }

  // A person's own payments whose name or description has every word searched for, or
  // whose amount is the one searched for, between two dates and in one group if asked,
  // newest first, with the group each is in.
  function search(person: number | null, options: { text?: string | null; from?: string | null; to?: string | null; group?: string | null }, limit = 500) {
    const query = (options.text ?? '').trim();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const { from, to, group } = options;
    if (!words.length && !group && !from && !to) return { results: [], total: 0 };
    const amount = /^\$?[\d,]+(\.\d{1,2})?$/.test(query) ? Number(query.replace(/[$,]/g, '')) : null;
    const found = load(
      accounts(person).map((a) => a.id),
      person,
    )
      .filter((t) => {
        if (from && t.posted < from) return false;
        if (to && t.posted > to) return false;
        if (group && t.group !== group) return false;
        if (!words.length) return true;
        if (amount !== null && Math.abs(Math.abs(t.amount) - amount) < 0.005) return true;
        const hay = `${t.description} ${t.payee ?? ''} ${nameOf(t)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .reverse();
    return {
      total: found.length,
      results: found
        .slice(0, limit)
        .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: nameOf(t), description: t.description, account: t.account, flow: t.flow, group: t.group, family: Boolean(t.family) })),
    };
  }

  // A category on money sent between family goes on both sides of the transfer.
  function setFamilyLabel(transactionId: number, labelId: number | null) {
    const row = db.prepare("SELECT id, transfer_id FROM bank_transactions WHERE id = ? AND kind = 'transfer' AND transfer_id IS NOT NULL").get(transactionId) as Row | undefined;
    if (!row) throw new Error('That is not a transfer between family.');
    if (labelId !== null && !db.prepare('SELECT 1 FROM personal_labels WHERE id = ?').get(labelId)) throw new Error('That category is not here.');
    db.prepare('UPDATE bank_transactions SET family_label_id = ? WHERE id IN (?, ?)').run(labelId, row.id, row.transfer_id);
  }

  const people = () => (db.prepare('SELECT id, name FROM personal_people ORDER BY name COLLATE NOCASE').all() as Row[]).map((p) => ({ id: Number(p.id), name: String(p.name) }));

  // A person's accounts with personal money in them: personal accounts, and shared ones
  // with some personal spending. A business's own accounts never count, even when a
  // payment in one was marked personal.
  function accounts(person: number | null) {
    return (
      db
        .prepare(
          `SELECT a.id, a.name, a.institution, a.kind, a.owner, a.balance, a.balance_date, a.person_id,
                  (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.id AND t.status = 'personal') AS personal
           FROM bank_accounts a WHERE a.owner != 'business' AND a.kind != 'investment' AND a.person_id IS ? ORDER BY a.name COLLATE NOCASE`,
        )
        .all(person) as Row[]
    )
      .filter((a) => a.owner === 'personal' || a.personal > 0)
      .map((a) => ({
        id: Number(a.id),
        name: String(a.name),
        institution: a.institution ?? null,
        kind: a.kind,
        balance: a.balance ?? null,
        balanceDate: a.balance_date ?? null,
        transactions: a.personal,
      }));
  }

  function summary(options: SummaryOptions = {}) {
    const todayDate = today();
    const thisMonth = monthOf(todayDate);
    const person = options.person ?? null;
    const year = options.year && /^\d{4}$/.test(options.year) ? options.year : null;
    const period: 'month' | 'year' = year ? 'year' : 'month';
    const month = year
      ? thisMonth.startsWith(year)
        ? thisMonth
        : `${year}-12` < thisMonth
          ? `${year}-12`
          : `${year}-01`
      : options.month && /^\d{4}-\d{2}$/.test(options.month)
        ? options.month
        : thisMonth;
    const span = year ? range(`${year}-01`, `${year}-12`) : [month];

    const mine = accounts(person);
    // Accounts picked that aren't this person's are ignored; none left means all of theirs.
    const picked = options.accounts?.length ? mine.filter((a) => options.accounts!.includes(a.id)) : [];
    const chosen = picked.length ? picked : mine;
    const all = load(
      chosen.map((a) => a.id),
      person,
    );
    const plan = budgets(person);
    // Spending groups: the usual ones and the person's own.
    const SPENDING: string[] = [...SPENDING_GROUPS, ...customKeys(person)];

    // Totals for each month and group.
    const byMonth = new Map<string, Map<string, number>>();
    const add = (m: string, g: string, n: number) => {
      let groups = byMonth.get(m);
      if (!groups) byMonth.set(m, (groups = new Map()));
      groups.set(g, (groups.get(g) || 0) + n);
    };
    for (const t of all) add(t.month, t.group, t.amount);
    const groupTotal = (m: string, g: string) => byMonth.get(m)?.get(g) || 0;
    const spentIn = (m: string) => -SPENDING.reduce((s, g) => s + groupTotal(m, g), 0);
    const earnedIn = (m: string) => INCOME_GROUPS.reduce((s, g) => s + groupTotal(m, g), 0);
    const sum = (list: string[], f: (m: string) => number) => list.reduce((s, m) => s + f(m), 0);

    // Typical months: the median of the last six complete ones, so one tuition bill
    // or holiday doesn't set the pace.
    const recent = range(addMonths(thisMonth, -6), addMonths(thisMonth, -1));
    const typical = Object.fromEntries(SPENDING.map((g) => [g, cents(Math.max(0, -median(recent.map((m) => groupTotal(m, g)))))])) as Record<string, number>;
    const expected = (g: string) => plan[g] ?? typical[g];

    // Regular payments: the same payee in most of the last six months.
    const seriesMonths = new Map<string, { months: Map<string, number>; days: number[]; group: Group; flow: Flow; name: string }>();
    // A payee paid twice a month (a paycheck on the 15th and the 30th) is two regular
    // payments, one for each time in the month, not one of twice the size.
    const slots = new Map<string, number>();
    for (const t of all) {
      if (!recent.includes(t.month) && t.month !== thisMonth) continue;
      const slot = (slots.get(`${t.series}|${t.month}`) || 0) + 1;
      slots.set(`${t.series}|${t.month}`, slot);
      const key = `${t.series}#${slot}`;
      let s = seriesMonths.get(key);
      if (!s) seriesMonths.set(key, (s = { months: new Map(), days: [], group: t.group, flow: t.flow, name: nameOf(t) }));
      s.months.set(t.month, (s.months.get(t.month) || 0) + t.amount);
      s.days.push(t.day);
    }
    const recurring = [...seriesMonths.entries()]
      .map(([key, s]) => {
        const seen = recent.filter((m) => s.months.has(m));
        const lastFour = recent.slice(-4).filter((m) => s.months.has(m)).length;
        if (s.flow === 'move' || !(seen.length >= 4 || lastFour >= 3)) return null;
        return {
          key,
          name: s.name,
          flow: s.flow,
          group: s.group,
          amount: cents(median(seen.map((m) => s.months.get(m) as number))),
          day: Math.round(median(s.days)),
          months: seen.length,
          paidThisMonth: s.months.has(thisMonth),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && Math.abs(r.amount) >= 1)
      .sort((a, b) => a.day - b.day);
    const recurringIncome = recurring.filter((r) => r.flow === 'in');

    // Where a month is heading: what's in so far plus the regular pay still to come,
    // and for each kind of spending the larger of what's gone out and what's expected.
    const projectedEarned = (m: string) =>
      m === thisMonth ? earnedIn(m) + recurringIncome.filter((r) => !r.paidThisMonth).reduce((s, r) => s + r.amount, 0) : recurringIncome.reduce((s, r) => s + r.amount, 0);
    const projectedSpent = (m: string) => SPENDING.reduce((s, g) => s + (m === thisMonth ? Math.max(-groupTotal(m, g), expected(g)) : expected(g)), 0);

    // The months shown: a year back and six months ahead, or around what was picked.
    let first = addMonths(thisMonth, -12);
    let last = addMonths(thisMonth, 6);
    if (span[0] < first || span[span.length - 1] > last) {
      first = addMonths(span[0], year ? -3 : -6);
      last = addMonths(span[span.length - 1], year ? 3 : 6);
    }
    const firstData = all[0]?.month ?? thisMonth;
    const months = range(first, last).map((m) => {
      const future = m > thisMonth;
      const earned = future ? 0 : earnedIn(m);
      const spent = future ? 0 : spentIn(m);
      return {
        month: m,
        earned: cents(earned),
        spent: cents(spent),
        kept: cents(earned - spent),
        invested: cents(-(groupTotal(m, 'invested') + groupTotal(m, 'from_savings'))),
        business: cents(-groupTotal(m, 'business')),
        future,
        current: m === thisMonth,
        noData: m < firstData,
        projectedEarned: future || m === thisMonth ? cents(projectedEarned(m)) : null,
        projectedSpent: future || m === thisMonth ? cents(projectedSpent(m)) : null,
        cumulative: 0,
      };
    });
    // Running savings: what's been kept so far over the months shown, carried on by the forecast.
    let running = 0;
    for (const m of months) {
      running += m.future ? (m.projectedEarned ?? 0) - (m.projectedSpent ?? 0) : m.kept;
      m.cumulative = cents(running);
    }

    // What was picked, in detail: actual money for the months that have happened (this
    // one so far), a forecast for a span that's all ahead.
    const past = span.filter((m) => m <= thisMonth);
    const ahead = span.filter((m) => m > thisMonth);
    const future = past.length === 0;
    const current = span.includes(thisMonth);
    const n = span.length;
    const inSpan = all.filter((t) => span.includes(t.month));
    const groupRows = SPENDING.map((g) => {
      const list = inSpan.filter((t) => t.group === g);
      const merchants = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of list) {
        const name = nameOf(t);
        const key = name.toLowerCase();
        const found = merchants.get(key) || { name, amount: 0, count: 0 };
        found.amount += -t.amount;
        found.count++;
        merchants.set(key, found);
      }
      const actual = -list.reduce((s, t) => s + t.amount, 0);
      // How much of this usually goes out by this day of the month: rent on the 1st is
      // on pace on the 2nd, though a straight line through the month says otherwise.
      const byDay = period === 'month' && current ? Number(todayDate.slice(8, 10)) : null;
      const typicalSoFar =
        byDay === null ? null : cents(Math.max(0, -median(recent.map((m) => all.filter((t) => t.month === m && t.group === g && t.day <= byDay).reduce((s, t) => s + t.amount, 0)))));
      return {
        key: g,
        amount: cents(future ? expected(g) * n : actual),
        // Where it's heading by the end of the span.
        projected: cents(actual + ahead.length * expected(g) + (current ? Math.max(0, expected(g) + groupTotal(thisMonth, g)) : 0)),
        budget: plan[g] != null ? cents(plan[g] * n) : null,
        typical: cents(typical[g] * n),
        typicalSoFar,
        count: list.length,
        merchants: [...merchants.values()]
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 6)
          .map((x) => ({ ...x, amount: cents(x.amount) })),
        transactions: list
          .sort((a, b) => a.amount - b.amount)
          .slice(0, 60)
          .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: nameOf(t), description: t.description, account: t.account, guessed: t.guessed, category: t.category })),
      };
    });
    const sourceRows = INCOME_GROUPS.map((g) => {
      const list = future ? [] : inSpan.filter((t) => t.group === g);
      const payers = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of list) {
        const name = nameOf(t);
        const found = payers.get(name.toLowerCase()) || { name, amount: 0, count: 0 };
        found.amount += t.amount;
        found.count++;
        payers.set(name.toLowerCase(), found);
      }
      const amount = future ? n * recurringIncome.filter((r) => r.group === g).reduce((s, r) => s + r.amount, 0) : list.reduce((s, t) => s + t.amount, 0);
      return {
        key: g,
        amount: cents(amount),
        count: list.length,
        payers: [...payers.values()]
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 5)
          .map((x) => ({ ...x, amount: cents(x.amount) })),
      };
    }).filter((s) => s.amount !== 0);
    const moveRows = MOVE_GROUPS.map((g) => ({ key: g, amount: cents(inSpan.filter((t) => t.group === g).reduce((s, t) => s + t.amount, 0)) })).filter((m) => m.amount !== 0);

    // How the spending built up: day by day through a month, or month by month through
    // a year, beside a typical one.
    const expectedTotal = SPENDING.reduce((s, g) => s + expected(g), 0);
    const hasPlan = Object.keys(plan).length > 0;
    let pace: { unit: 'day' | 'month'; days: number; actual: number[]; typical: number[]; budget: number | null };
    if (period === 'year') {
      let run = 0;
      const typicalTotal = SPENDING.reduce((s, g) => s + typical[g], 0);
      pace = {
        unit: 'month',
        days: 12,
        actual: past.map((m) => cents((run += spentIn(m)))),
        typical: span.map((_, i) => cents(typicalTotal * (i + 1))),
        budget: hasPlan ? cents(expectedTotal * 12) : null,
      };
    } else {
      const days = daysIn(month);
      const cumulative = (m: string, upTo: number) => {
        const daily = Array(days).fill(0);
        for (const t of all) if (t.month === m && t.flow === 'out') daily[Math.min(days, t.day) - 1] += -t.amount;
        let run = 0;
        return daily.slice(0, upTo).map((d) => cents((run += d)));
      };
      const shownDays = current ? Number(todayDate.slice(8, 10)) : future ? 0 : days;
      const typicalCurves = recent.map((m) => cumulative(m, days));
      pace = {
        unit: 'day',
        days,
        actual: shownDays ? cumulative(month, shownDays) : [],
        typical: Array.from({ length: days }, (_, i) => cents(median(typicalCurves.map((c) => c[i] ?? c[c.length - 1] ?? 0)))),
        budget: hasPlan ? cents(expectedTotal) : null,
      };
    }

    const earned = future ? sum(span, projectedEarned) : sum(past, earnedIn);
    const spent = future ? sum(span, projectedSpent) : sum(past, spentIn);
    // Where a span under way is heading: what's happened, plus the forecast for the rest.
    const outlook =
      current && !future
        ? {
            earned: cents(sum(span, (m) => (m < thisMonth ? earnedIn(m) : projectedEarned(m)))),
            spent: cents(sum(span, (m) => (m < thisMonth ? spentIn(m) : projectedSpent(m)))),
          }
        : null;
    const upcoming = (() => {
      // Regular payments still to come in the next five weeks.
      const out: { name: string; flow: Flow; group: Group; amount: number; on: string }[] = [];
      const end = new Date(Date.parse(`${todayDate}T00:00:00Z`) + 35 * 86400000).toISOString().slice(0, 10);
      for (const m of [thisMonth, addMonths(thisMonth, 1)]) {
        for (const r of recurring) {
          if (m === thisMonth && r.paidThisMonth) continue;
          const on = `${m}-${String(Math.min(r.day, daysIn(m))).padStart(2, '0')}`;
          if (on >= todayDate && on <= end) out.push({ name: r.name, flow: r.flow, group: r.group, amount: r.amount, on });
        }
      }
      return out.sort((a, b) => a.on.localeCompare(b.on));
    })();

    // The last twelve complete months together.
    const lastYear = range(addMonths(thisMonth, -12), addMonths(thisMonth, -1));
    const yearSpent = SPENDING.map((g) => ({ key: g, amount: cents(-lastYear.reduce((s, m) => s + groupTotal(m, g), 0)) })).filter((g) => g.amount > 0);
    const yearEarned = INCOME_GROUPS.map((g) => ({ key: g, amount: cents(lastYear.reduce((s, m) => s + groupTotal(m, g), 0)) })).filter((g) => g.amount > 0);

    const who = person === null ? null : (people().find((p) => p.id === person) ?? null);
    const unsorted = inSpan.filter((t) => t.guessed && (t.group === 'other' || t.group === 'other_in'));
    return {
      today: todayDate,
      thisMonth,
      period,
      month,
      year: year ?? month.slice(0, 4),
      span: { from: span[0], to: span[span.length - 1] },
      future,
      current,
      person: who,
      people: people(),
      firstMonth: firstData,
      accounts: mine,
      selectedAccounts: picked.map((a) => a.id),
      budgets: plan,
      groupNames: groupNames(person),
      customGroups: customGroups(person),
      groupRules: groupRules(person),
      typical,
      months,
      detail: {
        month,
        earned: cents(earned),
        spent: cents(spent),
        kept: cents(earned - spent),
        rate: earned > 0 ? Math.round(((earned - spent) / earned) * 1000) / 10 : null,
        outlook,
        groups: groupRows,
        sources: sourceRows,
        moves: moveRows,
        pace,
        biggest: inSpan
          .filter((t) => t.flow === 'out')
          .sort((a, b) => a.amount - b.amount)
          .slice(0, 6)
          .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: nameOf(t), group: t.group, account: t.account })),
        unsorted: unsorted.length,
        // The ones to give a category, for a link straight to them (Transactions takes up to 100).
        unsortedIds: unsorted.slice(0, 100).map((t) => t.id),
      },
      recurring,
      upcoming,
      familyLabels: labels(),
      // Money sent to and from other family members in what was picked, newest first.
      family: inSpan
        .filter((t) => t.family)
        .sort((a, b) => b.posted.localeCompare(a.posted) || b.id - a.id)
        .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: t.family!.other, account: t.account, labelId: t.family!.labelId, label: t.family!.label, group: t.group })),
      last12: { from: lastYear[0], to: lastYear[lastYear.length - 1], spent: yearSpent, earned: yearEarned },
    };
  }

  return {
    summary,
    budgets,
    setBudget,
    accounts,
    people,
    labels,
    addLabel,
    setFamilyLabel,
    setGroup,
    setGroups,
    groupRules,
    removeGroupRule,
    groupNames,
    renameGroup,
    customGroups,
    addCustomGroup,
    removeCustomGroup,
    search,
  };
}

export type PersonalService = ReturnType<typeof personalService>;

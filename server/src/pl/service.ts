// Profit and loss: revenue, operating expenses and net operating income from the
// business's own transactions (cash basis), month by month and year by year, and the
// return on the money invested in the properties.
//
// Revenue is money in filed as income (rental and other income). Operating expenses
// are business spending, net of refunds, with capital purchases on the asset register
// taken out and shown on their own. Transfers between accounts, security deposits
// (typed Ignored) and anything personal are in neither. Depreciation isn't counted:
// that's for the tax return.
//
// With several businesses, each is reported on its own: its own transactions (through
// its accounts, rules or splits), its own investment and start date. All of them
// together adds them up and lists each.
import type { DatabaseSync } from 'node:sqlite';
import type { BankStore } from '../bank/store';
import { incomeSource } from '../bank/merchant';
import type { IncomeSource } from '../bank/merchant';
import type { CorrelationService } from '../correlate/service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const INVESTED = 'pl.invested';
const INVESTED_ON = 'pl.investedOn';
const DAY_MS = 86400000;
const SOURCES: IncomeSource[] = ['airbnb', 'vrbo', 'booking', 'lease', 'other'];
const MARKET_VALUE = 'pl.marketValue.';
const LOAN_PAYMENTS = 'Loan & Mortgage Payments';

// Spending categories grouped for the cash-flow chart, first match wins. Capital
// purchases on the asset register are a group of their own.
export const CASH_GROUPS = ['Mortgages & Loans', 'Taxes', 'Insurance', 'Utilities', 'Fees & Services', 'Repairs & Maintenance', 'Supplies & Furnishings', 'Capital improvements', 'Admin & Other'] as const;
const GROUP_RULES: [(typeof CASH_GROUPS)[number], RegExp][] = [
  ['Mortgages & Loans', /mortgage|loan|interest/i],
  ['Taxes', /tax/i],
  ['Insurance', /insurance/i],
  ['Utilities', /utilit|phone|internet|water|propane|trash|electric/i],
  ['Fees & Services', /fee|advertis|listing|professional|software|subscription|management|commission/i],
  ['Repairs & Maintenance', /repair|maint|contractor|lawn|garden|tools|building|appliance/i],
  ['Supplies & Furnishings', /supplies|linen|bedding|household|kitchen|furniture|bath|grocery|paper|electronics|health/i],
];
export const cashGroup = (category: string) => GROUP_RULES.find(([, rule]) => rule.test(category))?.[0] ?? 'Admin & Other';

const monthsBefore = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
};

const cents = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const shiftDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

export type PlPeriod = { kind: 'year'; year: string } | { kind: 'ttm' } | { kind: 'all' };

export function plService({ db, bank, correlate }: { db: DatabaseSync; bank: BankStore; correlate: CorrelationService }) {
  const today = () => iso(new Date());

  // What was invested and when: one business's own figures, or for all of them the
  // total and the earliest date. Before any business has its own, one amount for all.
  function settings(entity: number | null = null) {
    const list = correlate.entities();
    if (entity !== null) {
      const e = list.find((x) => x.id === entity);
      return { invested: e?.invested ?? null, investedOn: e?.investedOn ?? null };
    }
    const own = list.filter((e) => e.invested);
    if (own.length) {
      const dates = own.map((e) => e.investedOn).filter((d): d is string => Boolean(d)).sort();
      return { invested: cents(own.reduce((t, e) => t + (e.invested || 0), 0)), investedOn: dates[0] ?? null };
    }
    return { invested: Number(bank.getSetting(INVESTED)) || null, investedOn: bank.getSetting(INVESTED_ON) || null };
  }
  function saveSettings(input: { entityId?: number | null; invested: number | null; investedOn: string | null }) {
    if (input.entityId) {
      const e = correlate.entities().find((x) => x.id === input.entityId);
      if (!e) throw new Error('That business was not found.');
      correlate.saveEntity({ ...e, invested: input.invested, investedOn: input.investedOn });
      return settings(input.entityId);
    }
    bank.setSetting(INVESTED, input.invested ? String(input.invested) : null);
    bank.setSetting(INVESTED_ON, input.investedOn || null);
    return settings();
  }

  // The first day counted: the day of the investment (costs before it, such as an
  // inspection, were part of buying), or else the first transaction.
  function firstDay(entity: number | null = null) {
    const on = settings(entity).investedOn;
    if (on) return on;
    return ((db.prepare(`SELECT MIN(posted) AS d FROM bank_transactions WHERE kind = 'normal'`).get() as Row).d as string | null) || today();
  }

  // Everything for one span of days: revenue by source and month, expenses by category
  // and month, and capital spending.
  function figures(from: string, to: string, entity: number | null = null) {
    const filters = { from, to, status: 'notpersonal', kind: 'normal' as const, entity: entity === null ? null : [entity] };
    // A transaction shared between businesses counts for this one's share.
    const shareOf = (tx: { entityId: number | null; shares: { entityId: number; percent: number }[] }) =>
      entity === null || !tx.shares.length ? 1 : (tx.shares.find((s) => s.entityId === entity)?.percent ?? 0) / 100;
    const months = new Map<string, { month: string; revenue: number; expenses: number; capital: number; sources: Record<IncomeSource, number>; byCategory: Map<string, number> }>();
    const at = (month: string) => {
      let m = months.get(month);
      if (!m) months.set(month, (m = { month, revenue: 0, expenses: 0, capital: 0, sources: { airbnb: 0, vrbo: 0, booking: 0, lease: 0, other: 0 }, byCategory: new Map() }));
      return m;
    };
    const sources: Record<IncomeSource, number> = { airbnb: 0, vrbo: 0, booking: 0, lease: 0, other: 0 };
    const incomeCategories = new Map<string, number>();
    for (const tx of bank.listTransactions({ ...filters, direction: 'in' }).transactions) {
      const amount = tx.amount * shareOf(tx);
      const source = incomeSource(`${tx.payee || ''} ${tx.description}`, tx.lease);
      sources[source] += amount;
      const m = at(tx.posted.slice(0, 7));
      m.revenue += amount;
      m.sources[source] += amount;
      const category = tx.category || 'Uncategorized';
      incomeCategories.set(category, (incomeCategories.get(category) || 0) + amount);
    }

    // Capital purchases on the asset register, by the charge that paid for them.
    const assets = db
      .prepare(
        `SELECT a.cost, a.transaction_id, t.posted, t.category FROM assets a JOIN bank_transactions t ON t.id = a.transaction_id
         WHERE t.posted BETWEEN ? AND ? AND (t.status IS NULL OR t.status != 'personal')
           ${entity === null ? '' : 'AND COALESCE(a.entity_id, t.entity_id) = ?'}`
      )
      .all(from, to, ...(entity === null ? [] : [entity])) as Row[];
    const capitalByCategory = new Map<string, number>();
    for (const a of assets) {
      const month = at((a.posted as string).slice(0, 7));
      month.capital += a.cost;
      const category = a.category || 'Uncategorized';
      month.byCategory.set(category, (month.byCategory.get(category) || 0) - a.cost);
      capitalByCategory.set(category, (capitalByCategory.get(category) || 0) + a.cost);
    }

    // Spending split by item where store orders say so, personal items left out.
    const categories = new Map<string, number>();
    for (const line of correlate.spendLines({ from, to, status: null, kind: 'normal' })) {
      if (line.status === 'personal') continue;
      if (entity !== null && line.entityId !== entity) continue;
      const month = at(line.posted.slice(0, 7));
      month.expenses += line.amount;
      month.byCategory.set(line.category, (month.byCategory.get(line.category) || 0) + line.amount);
      categories.set(line.category, (categories.get(line.category) || 0) + line.amount);
    }
    for (const [category, cost] of capitalByCategory) categories.set(category, (categories.get(category) || 0) - cost);
    for (const m of months.values()) m.expenses -= m.capital;

    const revenue = cents([...months.values()].reduce((t, m) => t + m.revenue, 0));
    const expenses = cents([...months.values()].reduce((t, m) => t + m.expenses, 0));
    const capital = cents(assets.reduce((t, a) => t + a.cost, 0));
    return {
      revenue,
      expenses,
      capital,
      noi: cents(revenue - expenses),
      sources: SOURCES.map((key) => ({ key, amount: cents(sources[key]) })).filter((s) => s.amount !== 0),
      incomeCategories: [...incomeCategories.entries()].map(([category, amount]) => ({ category, amount: cents(amount) })).sort((a, b) => b.amount - a.amount),
      categories: [...categories.entries()]
        .map(([category, amount]) => ({ category, amount: cents(amount) }))
        .filter((c) => Math.abs(c.amount) >= 0.005)
        .sort((a, b) => b.amount - a.amount),
      months: [...months.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({
          month: m.month,
          revenue: cents(m.revenue),
          expenses: cents(m.expenses),
          capital: cents(m.capital),
          noi: cents(m.revenue - m.expenses),
          sources: Object.fromEntries(SOURCES.map((k) => [k, cents(m.sources[k])])) as Record<IncomeSource, number>,
          byCategory: m.byCategory,
        })),
    };
  }

  // A business's market value, entered by hand; for all of them, the total of those set.
  function marketValue(entity: number) {
    return Number(bank.getSetting(MARKET_VALUE + entity)) || null;
  }
  function saveMarketValue(entityId: number, value: number | null) {
    if (!correlate.entities().some((e) => e.id === entityId)) throw new Error('That business was not found.');
    bank.setSetting(MARKET_VALUE + entityId, value ? String(value) : null);
  }

  // Money in and out month by month, like a bank statement would show it: income, then
  // spending in groups, loan payments (interest and principal) and capital purchases.
  // Also what the business is worth (market value less debt, plus cash in its
  // accounts) and the cash-on-cash return on what was invested.
  function cashFlow(entity: number | null = null) {
    const now = today();
    const current = now.slice(0, 7);
    const first = monthsBefore(current, 24);
    const f = figures(`${first}-01`, now, entity);
    const empty = () => Object.fromEntries(CASH_GROUPS.map((g) => [g, 0])) as Record<(typeof CASH_GROUPS)[number], number>;
    const byMonth = new Map<string, { income: number; groups: ReturnType<typeof empty> }>();
    for (let i = 24; i >= 0; i--) byMonth.set(monthsBefore(current, i), { income: 0, groups: empty() });
    for (const m of f.months) {
      const slot = byMonth.get(m.month);
      if (!slot) continue;
      slot.income += m.revenue;
      for (const [category, amount] of m.byCategory) slot.groups[cashGroup(category)] += amount;
      slot.groups['Capital improvements'] += m.capital;
    }
    // Loan principal is a transfer, so it isn't an expense, but it is money out.
    const principal = bank.listTransactions({
      from: `${first}-01`,
      to: now,
      status: 'notpersonal',
      kind: 'transfer',
      direction: 'out',
      category: [LOAN_PAYMENTS],
      entity: entity === null ? null : [entity],
    }).transactions;
    for (const tx of principal) {
      const slot = byMonth.get(tx.posted.slice(0, 7));
      if (slot) slot.groups['Mortgages & Loans'] += Math.abs(tx.amount);
    }
    const months = [...byMonth.entries()].map(([month, m]) => {
      const groups = Object.fromEntries(Object.entries(m.groups).map(([g, v]) => [g, cents(v)])) as ReturnType<typeof empty>;
      const out = Object.values(m.groups).reduce((t, v) => t + v, 0);
      return { month, income: cents(m.income), groups, out: cents(out), net: cents(m.income - out) };
    });

    // The last twelve whole months, and the one before this.
    const whole = months.slice(-13, -1);
    const sum = (list: typeof months, pick: (m: (typeof months)[number]) => number) => cents(list.reduce((t, m) => t + pick(m), 0));
    const debt = (m: (typeof months)[number]) => m.groups['Mortgages & Loans'];
    const capital = (m: (typeof months)[number]) => m.groups['Capital improvements'];
    const ttm = {
      from: `${whole[0].month}-01`,
      to: `${whole[whole.length - 1].month}-${String(new Date(Date.UTC(Number(whole[whole.length - 1].month.slice(0, 4)), Number(whole[whole.length - 1].month.slice(5)), 0)).getUTCDate()).padStart(2, '0')}`,
      income: sum(whole, (m) => m.income),
      expenses: sum(whole, (m) => m.out - debt(m) - capital(m)),
      debt: sum(whole, debt),
      capital: sum(whole, capital),
      net: sum(whole, (m) => m.net),
    };
    const invested = settings(entity).invested;
    // Cash on cash at the end of each of the last twelve months: the twelve months to
    // then, over what was invested.
    const cocSeries = months.slice(-13, -1).map((m, i) => {
      const window = months.slice(i + 1, i + 13);
      return { month: m.month, value: invested ? sum(window, (x) => x.net) / invested : null };
    });

    // Worth: market values less what's owed, plus cash in the business's accounts.
    const businesses = correlate.entities().filter((e) => entity === null || e.id === entity);
    const values = businesses.map((e) => ({ id: e.id, name: e.name, value: marketValue(e.id) }));
    let cash = 0;
    let owed = 0;
    for (const a of bank.accounts()) {
      if (a.balance === null || a.owner === 'personal') continue;
      if (entity !== null && a.entityId !== entity) continue;
      if (a.kind === 'loan') owed += Math.abs(a.balance);
      else if (a.kind === 'credit') owed += Math.max(-a.balance, 0);
      else if (a.balance > 0) cash += a.balance;
    }
    const value = cents(values.reduce((t, v) => t + (v.value || 0), 0));
    // The categories in each group, so a group can be shown as transactions.
    const groupCategories = Object.fromEntries(CASH_GROUPS.map((g) => [g, [] as string[]])) as Record<(typeof CASH_GROUPS)[number], string[]>;
    for (const { name } of db.prepare('SELECT name FROM categories ORDER BY name').all() as Row[]) groupCategories[cashGroup(name)].push(name);
    groupCategories['Admin & Other'].push('none');
    groupCategories['Capital improvements'] = [];
    return {
      groups: CASH_GROUPS,
      groupCategories,
      months: months.slice(-13),
      lastMonth: months[months.length - 2],
      average: whole.length ? cents(ttm.net / whole.length) : 0,
      ttm,
      invested,
      cashOnCash: invested ? ttm.net / invested : null,
      cocSeries,
      netWorth: { value, values, debt: cents(owed), cash: cents(cash), total: cents(value - owed + cash) },
    };
  }

  // Net operating income over a year, from the days actually covered, and as a share
  // of the money invested.
  function returns(noi: number, from: string, to: string, entity: number | null = null) {
    const span = Math.max(1, days(from, to));
    const annualNoi = cents((noi * 365) / span);
    const { invested } = settings(entity);
    return { days: span, annualNoi, annualReturn: invested ? annualNoi / invested : null, periodReturn: invested ? noi / invested : null };
  }

  function periodRange(period: PlPeriod, entity: number | null = null) {
    const start = firstDay(entity);
    const end = today();
    if (period.kind === 'all') return { from: start, to: end, label: 'Since the start' };
    if (period.kind === 'ttm') {
      const from = shiftDays(end, -364);
      return { from: from > start ? from : start, to: end, label: 'Last 12 months' };
    }
    const from = `${period.year}-01-01` > start ? `${period.year}-01-01` : start;
    const to = `${period.year}-12-31` < end ? `${period.year}-12-31` : end;
    return { from, to, label: period.year };
  }

  function report(period: PlPeriod, entity: number | null = null) {
    const start = firstDay(entity);
    const range = periodRange(period, entity);
    const main = range.from <= range.to ? figures(range.from, range.to, entity) : figures(range.to, range.to, entity);

    // Each year so far, for comparing.
    const years: Row[] = [];
    for (let y = Number(start.slice(0, 4)); y <= Number(today().slice(0, 4)); y++) {
      const r = periodRange({ kind: 'year', year: String(y) }, entity);
      if (r.from > r.to) continue;
      const f = figures(r.from, r.to, entity);
      const ret = returns(f.noi, r.from, r.to, entity);
      const prev = years.at(-1);
      years.push({
        year: String(y),
        from: r.from,
        to: r.to,
        revenue: f.revenue,
        expenses: f.expenses,
        capital: f.capital,
        noi: f.noi,
        margin: f.revenue ? f.noi / f.revenue : null,
        ...ret,
        // Against the year before, both put on a full-year footing.
        annualRevenue: cents((f.revenue * 365) / ret.days),
        revenueChange: prev && prev.annualRevenue ? (f.revenue * 365) / ret.days / prev.annualRevenue - 1 : null,
        noiChange: prev && prev.annualNoi > 0 ? ret.annualNoi / prev.annualNoi - 1 : null,
      });
    }

    const all = figures(start, today(), entity);
    const ttmRange = periodRange({ kind: 'ttm' }, entity);
    const ttm = figures(ttmRange.from, ttmRange.to, entity);
    const ttmReturn = returns(ttm.noi, ttmRange.from, ttmRange.to, entity);
    const { invested } = settings(entity);

    // All businesses together: each on its own for the same period, from its own start.
    const businesses =
      entity === null
        ? correlate.entities().map((e) => {
            const r = periodRange(period, e.id);
            const f = r.from <= r.to ? figures(r.from, r.to, e.id) : { revenue: 0, expenses: 0, capital: 0, noi: 0 };
            const ret = returns(f.noi, r.from, r.to, e.id);
            return { id: e.id, name: e.name, activity: e.activity, taxForm: e.taxForm, invested: e.invested, from: r.from, to: r.to, revenue: f.revenue, expenses: f.expenses, capital: f.capital, noi: f.noi, ...ret };
          })
        : [];
    const assigned = businesses.reduce((t, b) => t + b.revenue - b.expenses, 0);
    return {
      entity,
      settings: settings(entity),
      businesses,
      // Revenue less expenses on transactions that belong to no business.
      unassigned: entity === null && businesses.length ? cents(main.noi - assigned) : 0,
      start,
      period: { ...range, kind: period.kind, year: period.kind === 'year' ? period.year : null },
      years: years.map(({ annualRevenue: _unused, ...rest }) => rest),
      ...main,
      months: main.months.map(({ byCategory: _unused, ...rest }) => rest),
      margin: main.revenue ? main.noi / main.revenue : null,
      ...returns(main.noi, range.from, range.to, entity),
      ttm: { from: ttmRange.from, to: ttmRange.to, revenue: ttm.revenue, expenses: ttm.expenses, noi: ttm.noi, ...ttmReturn },
      sinceStart: {
        from: start,
        noi: all.noi,
        capital: all.capital,
        // Money put in: the purchase and capital improvements since.
        invested: invested ? cents(invested + all.capital) : null,
        recovered: invested ? all.noi / invested : null,
        // Years for net operating income at the last 12 months' pace to repay what was put in.
        payback: invested && ttmReturn.annualNoi > 0 ? (invested + all.capital - Math.max(0, all.noi)) / ttmReturn.annualNoi : null,
      },
    };
  }

  return { settings, saveSettings, report, cashFlow, saveMarketValue };
}

export type PlService = ReturnType<typeof plService>;

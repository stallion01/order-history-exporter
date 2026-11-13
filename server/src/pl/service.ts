// Profit and loss: revenue, operating expenses and net operating income from the
// business's own transactions (cash basis), month by month and year by year, and the
// return on the money invested in the properties.
//
// Revenue is money in filed as income (rental and other income). Operating expenses
// are business spending, net of refunds, with capital purchases on the asset register
// taken out and shown on their own. Transfers between accounts, security deposits
// (typed Ignored) and anything personal are in neither. Depreciation isn't counted:
// that's for the tax return.
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

const cents = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const shiftDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

export type PlPeriod = { kind: 'year'; year: string } | { kind: 'ttm' } | { kind: 'all' };

export function plService({ db, bank, correlate }: { db: DatabaseSync; bank: BankStore; correlate: CorrelationService }) {
  const today = () => iso(new Date());

  function settings() {
    const invested = Number(bank.getSetting(INVESTED)) || null;
    return { invested, investedOn: bank.getSetting(INVESTED_ON) || null };
  }
  function saveSettings(input: { invested: number | null; investedOn: string | null }) {
    bank.setSetting(INVESTED, input.invested ? String(input.invested) : null);
    bank.setSetting(INVESTED_ON, input.investedOn || null);
    return settings();
  }

  // The first day counted: the day of the investment (costs before it, such as an
  // inspection, were part of buying), or else the first transaction.
  function firstDay() {
    const on = settings().investedOn;
    if (on) return on;
    return ((db.prepare(`SELECT MIN(posted) AS d FROM bank_transactions WHERE kind = 'normal'`).get() as Row).d as string | null) || today();
  }

  // Everything for one span of days: revenue by source and month, expenses by category
  // and month, and capital spending.
  function figures(from: string, to: string) {
    const filters = { from, to, status: 'notpersonal', kind: 'normal' as const };
    const months = new Map<string, { month: string; revenue: number; expenses: number; capital: number; sources: Record<IncomeSource, number> }>();
    const at = (month: string) => {
      let m = months.get(month);
      if (!m) months.set(month, (m = { month, revenue: 0, expenses: 0, capital: 0, sources: { airbnb: 0, vrbo: 0, booking: 0, lease: 0, other: 0 } }));
      return m;
    };
    const sources: Record<IncomeSource, number> = { airbnb: 0, vrbo: 0, booking: 0, lease: 0, other: 0 };
    const incomeCategories = new Map<string, number>();
    for (const tx of bank.listTransactions({ ...filters, direction: 'in' }).transactions) {
      const source = incomeSource(`${tx.payee || ''} ${tx.description}`);
      sources[source] += tx.amount;
      const m = at(tx.posted.slice(0, 7));
      m.revenue += tx.amount;
      m.sources[source] += tx.amount;
      const category = tx.category || 'Uncategorized';
      incomeCategories.set(category, (incomeCategories.get(category) || 0) + tx.amount);
    }

    // Capital purchases on the asset register, by the charge that paid for them.
    const assets = db
      .prepare(
        `SELECT a.cost, a.transaction_id, t.posted, t.category FROM assets a JOIN bank_transactions t ON t.id = a.transaction_id
         WHERE t.posted BETWEEN ? AND ? AND (t.status IS NULL OR t.status != 'personal')`
      )
      .all(from, to) as Row[];
    const capitalByCategory = new Map<string, number>();
    for (const a of assets) {
      at((a.posted as string).slice(0, 7)).capital += a.cost;
      const category = a.category || 'Uncategorized';
      capitalByCategory.set(category, (capitalByCategory.get(category) || 0) + a.cost);
    }

    // Spending split by item where store orders say so, personal items left out.
    const categories = new Map<string, number>();
    for (const line of correlate.spendLines({ from, to, status: null, kind: 'normal' })) {
      if (line.status === 'personal') continue;
      at(line.posted.slice(0, 7)).expenses += line.amount;
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
        })),
    };
  }

  // Net operating income over a year, from the days actually covered, and as a share
  // of the money invested.
  function returns(noi: number, from: string, to: string) {
    const span = Math.max(1, days(from, to));
    const annualNoi = cents((noi * 365) / span);
    const { invested } = settings();
    return { days: span, annualNoi, annualReturn: invested ? annualNoi / invested : null, periodReturn: invested ? noi / invested : null };
  }

  function periodRange(period: PlPeriod) {
    const start = firstDay();
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

  function report(period: PlPeriod) {
    const start = firstDay();
    const range = periodRange(period);
    const main = range.from <= range.to ? figures(range.from, range.to) : figures(range.to, range.to);

    // Each year so far, for comparing.
    const years: Row[] = [];
    for (let y = Number(start.slice(0, 4)); y <= Number(today().slice(0, 4)); y++) {
      const r = periodRange({ kind: 'year', year: String(y) });
      if (r.from > r.to) continue;
      const f = figures(r.from, r.to);
      const ret = returns(f.noi, r.from, r.to);
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

    const all = figures(start, today());
    const ttmRange = periodRange({ kind: 'ttm' });
    const ttm = figures(ttmRange.from, ttmRange.to);
    const ttmReturn = returns(ttm.noi, ttmRange.from, ttmRange.to);
    const { invested } = settings();
    return {
      settings: settings(),
      start,
      period: { ...range, kind: period.kind, year: period.kind === 'year' ? period.year : null },
      years: years.map(({ annualRevenue: _unused, ...rest }) => rest),
      ...main,
      margin: main.revenue ? main.noi / main.revenue : null,
      ...returns(main.noi, range.from, range.to),
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

  return { settings, saveSettings, report };
}

export type PlService = ReturnType<typeof plService>;

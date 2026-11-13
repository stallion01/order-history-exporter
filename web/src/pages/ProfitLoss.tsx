// Profit and loss: revenue, operating expenses and net operating income, year by year,
// and the return on the money invested in the properties.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { post, useApi } from '../api';
import { MonthlyInOut } from '../charts';
import type { IncomeSource } from '../charts';
import { money, monthLabel, wholeMoney } from '../format';
import { Banner, Button, Card, Field, Input, Loading, PageHeader, Stat, TD, TH, TR, cx } from '../ui';

interface Month {
  month: string;
  revenue: number;
  expenses: number;
  capital: number;
  noi: number;
  sources: Record<IncomeSource, number>;
}
interface Year {
  year: string;
  from: string;
  to: string;
  revenue: number;
  expenses: number;
  capital: number;
  noi: number;
  margin: number | null;
  days: number;
  annualNoi: number;
  annualReturn: number | null;
  revenueChange: number | null;
  noiChange: number | null;
}
interface Report {
  settings: { invested: number | null; investedOn: string | null };
  start: string;
  period: { from: string; to: string; label: string; kind: 'year' | 'ttm' | 'all'; year: string | null };
  years: Year[];
  revenue: number;
  expenses: number;
  capital: number;
  noi: number;
  margin: number | null;
  days: number;
  annualNoi: number;
  annualReturn: number | null;
  periodReturn: number | null;
  sources: { key: IncomeSource; amount: number }[];
  categories: { category: string; amount: number }[];
  months: Month[];
  ttm: { from: string; to: string; revenue: number; expenses: number; noi: number; annualNoi: number; annualReturn: number | null };
  sinceStart: { from: string; noi: number; capital: number; invested: number | null; recovered: number | null; payback: number | null };
}

const SOURCE_NAMES: Record<IncomeSource, string> = { airbnb: 'Airbnb', vrbo: 'Vrbo', booking: 'Booking.com', lease: 'Leases', other: 'Direct bookings and other' };
const SOURCE_COLOURS: Record<IncomeSource, string> = {
  airbnb: 'bg-[var(--color-airbnb)]',
  vrbo: 'bg-[var(--color-vrbo)]',
  booking: 'bg-[var(--color-booking)]',
  lease: 'bg-[var(--color-lease)]',
  other: 'bg-[var(--color-other-income)]',
};

const pct = (n: number | null, digits = 1) => (n === null || !Number.isFinite(n) ? '–' : `${(n * 100).toFixed(digits)}%`);
const signedPct = (n: number | null) => (n === null || !Number.isFinite(n) ? '–' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`);
const dayText = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const tone = (n: number) => (n < 0 ? 'text-red-700 dark:text-red-400' : '');

export function ProfitLoss() {
  const [params, setParams] = useSearchParams();
  const period = params.get('period') || String(new Date().getFullYear());
  const data = useApi<Report>(`/api/pl?period=${encodeURIComponent(period)}`);
  const report = data.data;

  return (
    <>
      <PageHeader
        title="Profit & loss"
        description="Revenue less operating expenses, from your business transactions, and the return on what you invested."
      />
      {data.error && <Banner>{data.error.message}</Banner>}
      {!report && data.loading && <Loading />}
      {report && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap rounded-md border border-slate-300 p-0.5 text-sm font-medium dark:border-slate-700" role="group" aria-label="Period">
              {[...report.years.map((y) => [y.year, y.year]), ['ttm', 'Last 12 months'], ['all', 'Since the start']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={period === value}
                  onClick={() => setParams(value === String(new Date().getFullYear()) ? {} : { period: value })}
                  className={cx('rounded px-3 py-1', period === value ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-300')}
                >
                  {label}
                </button>
              ))}
            </div>
            <Investment settings={report.settings} onSaved={data.reload} />
          </div>

          {!report.settings.invested && (
            <Banner tone="warning">Enter the amount you invested to see your return.</Banner>
          )}

          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            {dayText(report.period.from)} to {dayText(report.period.to)} · {report.days} days
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Revenue" value={money(report.revenue)} />
            <Stat label="Operating expenses" value={money(report.expenses)} hint={report.capital ? `Plus ${money(report.capital)} capital improvements` : 'Capital improvements are counted separately'} />
            <Stat label="Net operating income" value={<span className={tone(report.noi)}>{money(report.noi)}</span>} hint={`${pct(report.margin)} of revenue`} />
            <Stat
              label="Annual return"
              value={<span className={tone(report.annualNoi)}>{pct(report.annualReturn, 2)}</span>}
              hint={report.settings.invested ? `${wholeMoney(report.annualNoi)} a year at this pace, on ${wholeMoney(report.settings.invested)}` : 'Enter the amount invested'}
            />
          </div>

          <Card title="Revenue and expenses by month" className="mt-5">
            <MonthlyInOut rows={report.months.map((m) => ({ month: m.month, spend: m.expenses, income: m.revenue, sources: m.sources }))} />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Month</th>
                    <th className={`${TH} text-right`}>Revenue</th>
                    <th className={`${TH} text-right`}>Expenses</th>
                    <th className={`${TH} text-right`}>Net</th>
                    <th className={`${TH} text-right`}>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {report.months.map((m) => (
                    <tr key={m.month} className={TR}>
                      <td className={TD}>
                        <Link to={`/transactions?preset=custom&from=${m.month}-01&to=${m.month}-${String(new Date(Number(m.month.slice(0, 4)), Number(m.month.slice(5)), 0).getDate()).padStart(2, '0')}`} className="hover:underline">
                          {monthLabel(m.month)}
                        </Link>
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{money(m.revenue)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{money(m.expenses)}</td>
                      <td className={cx(TD, 'text-right font-medium tabular-nums', tone(m.noi))}>{money(m.noi)}</td>
                      <td className={`${TD} text-right tabular-nums text-slate-600 dark:text-slate-400`}>{pct(m.revenue ? m.noi / m.revenue : null, 0)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={cx(TR, 'font-semibold')}>
                    <td className={TD}>Total</td>
                    <td className={`${TD} text-right tabular-nums`}>{money(report.revenue)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{money(report.expenses)}</td>
                    <td className={cx(TD, 'text-right tabular-nums', tone(report.noi))}>{money(report.noi)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{pct(report.margin, 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
            <Card title="Revenue by source">
              <Shares rows={report.sources.map((s) => ({ label: SOURCE_NAMES[s.key], amount: s.amount, colour: SOURCE_COLOURS[s.key] }))} total={report.revenue} of="of revenue" />
            </Card>
            <Card title="Operating expenses">
              <Shares rows={report.categories.map((c) => ({ label: c.category, amount: c.amount, colour: 'bg-[var(--color-bar)]' }))} total={report.revenue} of="of revenue" limit={12} />
            </Card>
          </div>

          <Card title="Year over year" className="mt-5" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Year</th>
                    <th className={`${TH} text-right`}>Revenue</th>
                    <th className={`${TH} text-right`}>Expenses</th>
                    <th className={`${TH} text-right`}>Net operating income</th>
                    <th className={`${TH} text-right`}>Margin</th>
                    <th className={`${TH} text-right`}>Net, full-year pace</th>
                    <th className={`${TH} text-right`}>Annual return</th>
                    <th className={`${TH} text-right`}>Revenue vs year before</th>
                    <th className={`${TH} text-right`}>Net vs year before</th>
                  </tr>
                </thead>
                <tbody>
                  {report.years.map((y) => (
                    <tr key={y.year} className={TR}>
                      <td className={TD}>
                        <div className="font-medium">{y.year}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {y.days < 365 ? `${dayText(y.from)} to ${dayText(y.to)}` : 'Full year'}
                        </div>
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{money(y.revenue)}</td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {money(y.expenses)}
                        {y.capital > 0 && <div className="text-xs text-slate-500 dark:text-slate-400">+ {money(y.capital)} capital</div>}
                      </td>
                      <td className={cx(TD, 'text-right font-medium tabular-nums', tone(y.noi))}>{money(y.noi)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{pct(y.margin, 0)}</td>
                      <td className={cx(TD, 'text-right tabular-nums', tone(y.annualNoi))}>{wholeMoney(y.annualNoi)}</td>
                      <td className={cx(TD, 'text-right font-medium tabular-nums', tone(y.annualNoi))}>{pct(y.annualReturn, 2)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{signedPct(y.revenueChange)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{signedPct(y.noiChange)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 pb-3 pt-2 text-xs text-slate-500 dark:text-slate-400">
              A part year is put on a full-year footing (its net × 365 ÷ days covered) so years compare fairly. Seasonal swings make a short year a rough guide.
            </p>
          </Card>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Last 12 months, net" value={<span className={tone(report.ttm.noi)}>{money(report.ttm.noi)}</span>} hint={`${pct(report.ttm.annualReturn, 2)} return · ${dayText(report.ttm.from)} on`} />
            <Stat label="Invested so far" value={report.sinceStart.invested ? wholeMoney(report.sinceStart.invested) : '–'} hint={report.sinceStart.capital ? `Including ${money(report.sinceStart.capital)} of improvements` : 'Purchase price'} />
            <Stat label="Net earned since the start" value={<span className={tone(report.sinceStart.noi)}>{money(report.sinceStart.noi)}</span>} hint={`${pct(report.sinceStart.recovered)} of the investment back`} />
            <Stat
              label="Payback at this pace"
              value={report.sinceStart.payback === null ? '–' : `${report.sinceStart.payback.toFixed(1)} years`}
              hint="Years of last-12-month net to earn back what's invested"
            />
          </div>

          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            Cash basis, from business transactions: rental and other income less spending net of refunds. Left out: transfers between your accounts, the purchase itself, security deposits held for tenants, anything
            marked Personal, depreciation, and costs paid from accounts not in the hub. Capital improvements from the asset register are shown apart from operating expenses. The return is before income tax and
            ignores any change in the properties' value.
          </p>
        </>
      )}
    </>
  );
}

// Amounts with their share of a total, as labelled bars.
function Shares({ rows, total, of, limit = 8 }: { rows: { label: string; amount: number; colour: string }[]; total: number; of: string; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="py-4 text-center text-sm text-slate-500">Nothing in this period.</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.amount)), 1);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <>
      <ul className="space-y-2">
        {shown.map((r) => (
          <li key={r.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums">
                {money(r.amount)} <span className="text-xs text-slate-500 dark:text-slate-400">{total ? `${((r.amount / total) * 100).toFixed(1)}% ${of}` : ''}</span>
              </span>
            </div>
            <div className="mt-1 h-2 rounded-r-full bg-slate-100 dark:bg-slate-800">
              <div className={cx('h-full rounded-r-full', r.colour)} style={{ width: `${Math.max(1, (Math.abs(r.amount) / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

// The amount invested and when, which returns are measured against.
function Investment({ settings, onSaved }: { settings: Report['settings']; onSaved: () => void }) {
  const [editing, setEditing] = useState(!settings.invested);
  const [form, setForm] = useState({ invested: settings.invested ? String(settings.invested) : '', investedOn: settings.investedOn || '' });
  const [error, setError] = useState('');
  useEffect(() => setForm({ invested: settings.invested ? String(settings.invested) : '', investedOn: settings.investedOn || '' }), [settings.invested, settings.investedOn]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await post('/api/pl/settings', { invested: form.invested ? Number(form.invested) : null, investedOn: form.investedOn || null });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!editing)
    return (
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span>
          Invested <span className="font-semibold text-slate-900 dark:text-slate-100">{wholeMoney(settings.invested || 0)}</span>
          {settings.investedOn && ` on ${dayText(settings.investedOn)}`}
        </span>
        <Button variant="ghost" aria-label="Change the amount invested" onClick={() => setEditing(true)}>
          <Pencil className="size-4" aria-hidden />
        </Button>
      </div>
    );
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <Field label="Amount invested ($)">
        <Input type="number" min="0" step="1" value={form.invested} onChange={(e) => setForm({ ...form, invested: e.target.value })} className="w-36" required />
      </Field>
      <Field label="Invested on">
        <Input type="date" value={form.investedOn} onChange={(e) => setForm({ ...form, investedOn: e.target.value })} />
      </Field>
      <Button type="submit" variant="primary">
        Save
      </Button>
      {settings.invested && <Button onClick={() => setEditing(false)}>Cancel</Button>}
      {error && <span className="text-sm text-red-700 dark:text-red-400">{error}</span>}
    </form>
  );
}

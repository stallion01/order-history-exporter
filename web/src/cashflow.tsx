// The dashboard's top: net cash flow, net worth and cash-on-cash return for the last
// twelve whole months, and money in and out month by month.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { post, useApi } from './api';
import { businessQuery, useBusiness } from './business';
import { money, monthLabel, wholeMoney } from './format';
import { Banner, Button, Card, Field, Input, Loading, cx } from './ui';

type Group = 'Mortgages & Loans' | 'Taxes' | 'Insurance' | 'Utilities' | 'Fees & Services' | 'Repairs & Maintenance' | 'Supplies & Furnishings' | 'Capital improvements' | 'Admin & Other';
interface CashMonth {
  month: string;
  income: number;
  groups: Record<Group, number>;
  out: number;
  net: number;
}
interface CashFlow {
  groups: Group[];
  months: CashMonth[];
  lastMonth: CashMonth;
  average: number;
  ttm: { from: string; to: string; income: number; expenses: number; debt: number; capital: number; net: number };
  invested: number | null;
  cashOnCash: number | null;
  cocSeries: { month: string; value: number | null }[];
  netWorth: { value: number; values: { id: number; name: string; value: number | null }[]; debt: number; cash: number; total: number };
}

const INCOME_COLOUR = '#2f8f6b';
const GROUP_COLOURS: Record<Group, string> = {
  'Mortgages & Loans': '#4f7fd9',
  Taxes: '#a35bb0',
  Insurance: '#f08c4a',
  Utilities: '#5a4aa6',
  'Fees & Services': '#e85d75',
  'Repairs & Maintenance': '#d2489a',
  'Supplies & Furnishings': '#2ea6b8',
  'Capital improvements': '#9a7444',
  'Admin & Other': '#e0bd3c',
};

const pct = (n: number | null, digits = 1) => (n === null ? '–' : `${(n * 100).toFixed(digits)}%`);
const tone = (n: number) => (n < 0 ? 'text-red-700 dark:text-red-400' : '');

export function CashFlowOverview() {
  const { business, current } = useBusiness();
  const data = useApi<CashFlow>(`/api/pl/cashflow?x=1${businessQuery(business)}`);
  if (data.error) return <Banner>{data.error.message}</Banner>;
  if (!data.data) return <Loading />;
  const d = data.data;
  const span = `${monthLabel(d.ttm.from.slice(0, 7), true)} – ${monthLabel(d.ttm.to.slice(0, 7), true)}`;
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-3">
        <NetCashFlowCard d={d} span={span} />
        <NetWorthCard d={d} entityId={current?.id ?? null} onSaved={data.reload} />
        <CashOnCashCard d={d} />
      </div>
      <Card title="Net cash flow by month" className="mt-5">
        <div className="mb-4 flex flex-wrap gap-8">
          <div>
            <div className={cx('text-3xl font-semibold tabular-nums', tone(d.lastMonth.net))}>{wholeMoney(d.lastMonth.net)}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Last month ({monthLabel(d.lastMonth.month)})</div>
          </div>
          <div>
            <div className={cx('text-3xl font-semibold tabular-nums', tone(d.average))}>{wholeMoney(d.average)}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Monthly average, last 12 months</div>
          </div>
        </div>
        <CashFlowChart months={d.months} groups={d.groups} />
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Money in and out of the business&apos;s accounts. Loan payments include principal; capital improvements are purchases on the asset register. Transfers between your own accounts and anything personal are left out.
        </p>
      </Card>
    </>
  );
}

function Row({ label, value, colour, of }: { label: string; value: number; colour?: string; of?: number }) {
  return (
    <div className="border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        <span className="tabular-nums">{money(value || 0)}</span>
      </div>
      {colour && of ? (
        <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="h-full rounded-full" style={{ width: `${value ? Math.min(100, Math.max(1, (Math.abs(value) / of) * 100)) : 0}%`, background: colour }} />
        </div>
      ) : null}
    </div>
  );
}

function NetCashFlowCard({ d, span }: { d: CashFlow; span: string }) {
  const largest = Math.max(d.ttm.income, d.ttm.expenses, d.ttm.debt, d.ttm.capital, 1);
  const params = new URLSearchParams({ preset: 'custom', from: d.ttm.from, to: d.ttm.to });
  return (
    <Card
      title="Net cash flow"
      actions={
        <Link to={`/transactions?${params}`} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          Transactions
        </Link>
      }
    >
      <div className={cx('text-3xl font-semibold tabular-nums', tone(d.ttm.net))}>{wholeMoney(d.ttm.net)}</div>
      <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">Last 12 months ({span})</div>
      <Row label="Income" value={d.ttm.income} colour={INCOME_COLOUR} of={largest} />
      <Row label="Operating expenses" value={-d.ttm.expenses} colour={GROUP_COLOURS['Admin & Other']} of={largest} />
      <Row label="Loan payments" value={-d.ttm.debt} colour={GROUP_COLOURS['Mortgages & Loans']} of={largest} />
      {d.ttm.capital !== 0 && <Row label="Capital improvements" value={-d.ttm.capital} colour={GROUP_COLOURS['Capital improvements']} of={largest} />}
    </Card>
  );
}

function NetWorthCard({ d, entityId, onSaved }: { d: CashFlow; entityId: number | null; onSaved: () => void }) {
  const w = d.netWorth;
  const missing = w.values.filter((v) => !v.value);
  const own = entityId === null ? null : w.values.find((v) => v.id === entityId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setValue(own?.value ? String(own.value) : ''), [own?.value]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await post('/api/pl/market-value', { entityId, value: value.trim() ? Number(value.replace(/[$,]/g, '')) : null });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Net worth">
      <div className={cx('text-3xl font-semibold tabular-nums', tone(w.total))}>{wholeMoney(w.total)}</div>
      <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">Market value, less what&apos;s owed, plus cash</div>
      {editing && own ? (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2 border-b border-slate-100 py-2 dark:border-slate-800">
          <Field label={`Market value of ${own.name}`} className="flex-1">
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1,200,000" autoFocus />
          </Field>
          <Button type="submit">Save</Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {error && <p className="basis-full text-xs text-red-700 dark:text-red-400">{error}</p>}
        </form>
      ) : (
        <div className="flex items-center gap-1">
          <div className="flex-1">
            <Row label="Market value" value={w.value} />
          </div>
          {own && (
            <Button variant="ghost" aria-label="Change the market value" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      )}
      <Row label="Debt" value={-w.debt} />
      <Row label="Cash" value={w.cash} />
      {own && !own.value && !editing && (
        <button type="button" onClick={() => setEditing(true)} className="mt-2 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400">
          Add the market value
        </button>
      )}
      {!own && missing.length > 0 && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No market value yet for {missing.map((m) => m.name).join(', ')}. Choose that business in the menu to add it.</p>
      )}
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Debt is the balance of accounts typed Loan, and what&apos;s owed on cards.{' '}
        <Link to="/accounts" className="text-emerald-700 hover:underline dark:text-emerald-400">
          Accounts
        </Link>
      </p>
    </Card>
  );
}

function CashOnCashCard({ d }: { d: CashFlow }) {
  const points = d.cocSeries.filter((p) => p.value !== null) as { month: string; value: number }[];
  return (
    <Card title="Cash-on-cash return">
      <div className={cx('text-3xl font-semibold tabular-nums', tone(d.cashOnCash ?? 0))}>{pct(d.cashOnCash)}</div>
      <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Last 12 months{d.invested ? `, on ${wholeMoney(d.invested)} invested` : ''}
      </div>
      {d.invested ? (
        <Sparkline points={points} />
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Set the amount invested on{' '}
          <Link to="/profit-loss" className="text-emerald-700 hover:underline dark:text-emerald-400">
            Profit &amp; loss
          </Link>{' '}
          to see the return.
        </p>
      )}
    </Card>
  );
}

// The trailing twelve-month return at the end of each month.
function Sparkline({ points }: { points: { month: string; value: number }[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(240);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (points.length < 2) return <p className="text-sm text-slate-500">Not enough months yet.</p>;
  const height = 120;
  const pad = { left: 44, right: 8, top: 10, bottom: 22 };
  const values = points.map((p) => p.value);
  let low = Math.min(...values, 0);
  let high = Math.max(...values, 0);
  if (high - low < 0.02) {
    high += 0.01;
    low -= 0.01;
  }
  const x = (i: number) => pad.left + (i / (points.length - 1)) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - low) / (high - low)) * (height - pad.top - pad.bottom);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  const shown = active === null ? points[points.length - 1] : points[active];
  return (
    <div ref={holder} className="relative">
      <svg width={width} height={height} role="img" aria-label="Cash-on-cash return over the last 12 months" className="block" onMouseLeave={() => setActive(null)}>
        {[high, 0, low].filter((v, i, list) => list.indexOf(v) === i).map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-slate-300 dark:stroke-slate-700' : 'stroke-slate-100 dark:stroke-slate-800'} />
            <text x={pad.left - 6} y={y(v) + 4} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums dark:fill-slate-400">
              {pct(v, 0)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#4f7fd9" strokeWidth={2} />
        {points.map((p, i) => (
          <g key={p.month} onMouseEnter={() => setActive(i)}>
            <rect x={x(i) - 10} y={0} width={20} height={height} fill="transparent" />
            <circle cx={x(i)} cy={y(p.value)} r={active === i ? 4 : 2.5} fill="#4f7fd9" />
          </g>
        ))}
        <text x={pad.left} y={height - 4} className="fill-slate-500 text-[10px] dark:fill-slate-400">
          {monthLabel(points[0].month, true)}
        </text>
        <text x={width - pad.right} y={height - 4} textAnchor="end" className="fill-slate-500 text-[10px] dark:fill-slate-400">
          {monthLabel(points[points.length - 1].month, true)}
        </text>
      </svg>
      <div className="text-xs text-slate-600 dark:text-slate-300">
        12 months to {monthLabel(shown.month)}: <span className="font-medium tabular-nums">{pct(shown.value)}</span>
      </div>
    </div>
  );
}

function niceStep(span: number) {
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
}

// Income as a bar above zero, money out stacked below it by group, and the month's net
// as a line. Clicking a month opens its transactions.
export function CashFlowChart({ months, groups }: { months: CashMonth[]; groups: Group[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [active, setActive] = useState<number | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const used = groups.filter((g) => months.some((m) => m.groups[g] !== 0));
  const height = 300;
  const pad = { left: 62, right: 8, top: 12, bottom: 28 };
  const top = Math.max(...months.map((m) => Math.max(m.income, m.net)), 0);
  const bottom = Math.min(...months.map((m) => Math.min(-m.out, m.net)), 0);
  const step = niceStep(Math.max(top - bottom, 1));
  const high = Math.ceil(top / step) * step || step;
  const low = Math.floor(bottom / step) * step;
  const ticks: number[] = [];
  for (let v = low; v <= high + step / 2; v += step) ticks.push(v);
  const plot = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plot * (1 - (v - low) / (high - low));
  const slot = (width - pad.left - pad.right) / months.length;
  const barWidth = Math.min(44, slot * 0.62);
  const centre = (i: number) => pad.left + slot * i + slot / 2;
  const labelEvery = Math.ceil(58 / slot);
  const open = (month: string) => {
    const [yy, mm] = month.split('-').map(Number);
    navigate(`/transactions?${new URLSearchParams({ preset: 'custom', from: `${month}-01`, to: `${month}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}` })}`);
  };
  const shown = active === null ? null : months[active];

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <div ref={holder} className="relative min-w-0 flex-1">
        <svg width={width} height={height} role="img" aria-label="Net cash flow by month" className="block">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-slate-400 dark:stroke-slate-600' : 'stroke-slate-200 dark:stroke-slate-800'} />
              <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums dark:fill-slate-400">
                {wholeMoney(v)}
              </text>
            </g>
          ))}
          {months.map((m, i) => {
            const left = centre(i) - barWidth / 2;
            let base = 0;
            const pieces = used
              .filter((g) => m.groups[g] > 0)
              .map((g) => {
                const from = base;
                base += m.groups[g];
                return <rect key={g} x={left} y={y(-from)} width={barWidth} height={Math.max(0.5, y(-base) - y(-from))} fill={GROUP_COLOURS[g]} />;
              });
            // Money back (refunds bigger than spending in a group) shows above zero.
            const back = used.filter((g) => m.groups[g] < 0).reduce((t, g) => t - m.groups[g], 0);
            return (
              <g
                key={m.month}
                role="link"
                tabIndex={0}
                aria-label={`${monthLabel(m.month)}: in ${money(m.income)}, out ${money(m.out)}, net ${money(m.net)}`}
                className="cursor-pointer outline-none"
                onClick={() => open(m.month)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(m.month))}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                opacity={active === null || active === i ? 1 : 0.55}
              >
                <rect x={pad.left + slot * i} y={pad.top} width={slot} height={plot} fill="transparent" />
                {m.income + back > 0 && <rect x={left} y={y(m.income + back)} width={barWidth} height={y(0) - y(m.income + back)} fill={INCOME_COLOUR} />}
                {pieces}
                {i % labelEvery === 0 && (
                  <text x={centre(i)} y={height - 8} textAnchor="middle" className="fill-slate-500 text-[11px] dark:fill-slate-400">
                    {monthLabel(m.month, true)}
                  </text>
                )}
              </g>
            );
          })}
          <path d={months.map((m, i) => `${i ? 'L' : 'M'}${centre(i)},${y(m.net)}`).join('')} fill="none" className="stroke-slate-700 dark:stroke-slate-200" strokeWidth={2} pointerEvents="none" />
          {months.map((m, i) => (
            <circle key={m.month} cx={centre(i)} cy={y(m.net)} r={active === i ? 4.5 : 3} className="fill-white stroke-slate-700 dark:fill-slate-900 dark:stroke-slate-200" strokeWidth={1.5} pointerEvents="none" />
          ))}
        </svg>
        {shown && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-56 rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
            style={{ left: Math.min(Math.max(centre(active!) - 112, 0), width - 224) }}
          >
            <div className="mb-1 font-semibold">{monthLabel(shown.month)}</div>
            <div className="flex justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm" style={{ background: INCOME_COLOUR }} aria-hidden /> Income
              </span>
              <span className="tabular-nums">{money(shown.income)}</span>
            </div>
            {used
              .filter((g) => shown.groups[g] !== 0)
              .map((g) => (
                <div key={g} className="flex justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: GROUP_COLOURS[g] }} aria-hidden /> {g}
                  </span>
                  <span className="tabular-nums">{money(-shown.groups[g] || 0)}</span>
                </div>
              ))}
            <div className="mt-1 flex justify-between gap-2 border-t border-slate-100 pt-1 font-semibold dark:border-slate-800">
              <span>Net cash flow</span>
              <span className={cx('tabular-nums', tone(shown.net))}>{money(shown.net)}</span>
            </div>
          </div>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 xl:w-48 xl:flex-col xl:flex-nowrap dark:text-slate-300">
        <li className="flex items-center gap-2">
          <span className="h-0.5 w-4 bg-slate-700 dark:bg-slate-200" aria-hidden /> Net cash flow
        </li>
        <li className="flex items-center gap-2">
          <span className="size-3 rounded-sm" style={{ background: INCOME_COLOUR }} aria-hidden /> Income
        </li>
        {used.map((g) => (
          <li key={g} className="flex items-center gap-2">
            <span className="size-3 rounded-sm" style={{ background: GROUP_COLOURS[g] }} aria-hidden /> {g}
          </li>
        ))}
      </ul>
    </div>
  );
}

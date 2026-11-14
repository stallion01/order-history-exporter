// Single-series charts in one hue, with values available on hover, focus and in text.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money, monthLabel, wholeMoney } from './format';

export interface Row {
  label: string;
  // The filter value behind the label, such as a store id.
  key?: string;
  // When one row covers several filter values, such as a city's ZIP codes.
  keys?: string[];
  spend: number;
  orders?: number;
}

function niceMax(value: number) {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

// Every month in the span, so a month without spending shows as a gap.
function fillMonths(rows: Row[]): Row[] {
  if (!rows.length) return [];
  const byKey = new Map(rows.map((row) => [row.label, row]));
  const [startYear, startMonth] = rows[0].label.split('-').map(Number);
  const [endYear, endMonth] = rows[rows.length - 1].label.split('-').map(Number);
  const out: Row[] = [];
  for (let y = startYear, m = startMonth; y < endYear || (y === endYear && m <= endMonth); ) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(byKey.get(key) || { label: key, orders: 0, spend: 0 });
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
  }
  return out;
}

export function MonthlyBars({ rows, onSelect }: { rows: Row[]; onSelect?: (row: Row) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
    // Again once there is a chart to measure (the data usually arrives after the first draw).
  }, [rows.length > 0]);

  const months = fillMonths(rows);
  if (!months.length) return <p className="py-6 text-center text-sm text-slate-500">No dated spending matches these filters.</p>;

  const margin = { top: 10, right: 8, bottom: 26, left: 58 };
  const height = 240;
  const slot = (width - margin.left - margin.right) / months.length;
  const plot = height - margin.top - margin.bottom;
  const top = niceMax(Math.max(...months.map((m) => m.spend), 0));
  const low = Math.min(...months.map((m) => m.spend), 0);
  const bottom = low < 0 ? -niceMax(-low) : 0;
  const y = (value: number) => margin.top + plot * (1 - (value - bottom) / (top - bottom));
  const ticks = bottom < 0 ? [bottom, 0, top] : [0, top / 4, top / 2, (top * 3) / 4, top];
  const barWidth = Math.min(24, Math.max(2, slot - 2));
  const labelEvery = Math.ceil(52 / slot);
  const shown = active === null ? null : months[active];

  return (
    <div ref={holder} className="relative">
      <svg width={width} height={height} role="img" aria-label="Spending by month" className="block">
        {ticks.map((value) => (
          <g key={value}>
            <line x1={margin.left} x2={width - margin.right} y1={y(value)} y2={y(value)} className="stroke-slate-200 dark:stroke-slate-800" />
            <text x={margin.left - 8} y={y(value) + 4} textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums dark:fill-slate-400">
              {wholeMoney(value)}
            </text>
          </g>
        ))}
        {months.map((month, index) => {
          const x = margin.left + index * slot;
          const up = month.spend >= 0;
          const barTop = y(Math.max(month.spend, 0));
          const barHeight = Math.max(month.spend ? 1 : 0, Math.abs(y(month.spend) - y(0)));
          const left = x + (slot - barWidth) / 2;
          const right = left + barWidth;
          const r = Math.min(4, barHeight, barWidth / 2);
          const end = barTop + barHeight;
          // Rounded only at the data end, square at the baseline.
          const d = up
            ? `M${left},${end}V${barTop + r}Q${left},${barTop} ${left + r},${barTop}H${right - r}Q${right},${barTop} ${right},${barTop + r}V${end}Z`
            : `M${left},${barTop}V${end - r}Q${left},${end} ${left + r},${end}H${right - r}Q${right},${end} ${right},${end - r}V${barTop}Z`;
          const [yearNumber, monthNumber] = month.label.split('-').map(Number);
          return (
            <g
              key={month.label}
              tabIndex={0}
              role={onSelect ? 'link' : undefined}
              aria-label={`${monthLabel(month.label)}: ${money(month.spend)}, ${month.orders} orders`}
              onClick={onSelect && month.orders ? () => onSelect(month) : undefined}
              onKeyDown={onSelect && month.orders ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(month)) : undefined}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className={`outline-none ${onSelect && month.orders ? 'cursor-pointer' : ''}`}
            >
              <rect x={x} y={margin.top} width={slot} height={plot} fill="transparent" />
              {barHeight > 0 && <path d={d} className={active === index ? 'fill-[var(--color-bar-hover)]' : 'fill-[var(--color-bar)]'} />}
              {index % labelEvery === 0 && (
                <text x={x + slot / 2} y={height - 8} textAnchor="middle" className="fill-slate-500 text-[11px] dark:fill-slate-400">
                  {labelEvery >= 12 ? yearNumber : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthNumber - 1]} ${String(yearNumber).slice(2)}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown && active !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md tabular-nums dark:border-slate-700 dark:bg-slate-900"
          style={{ left: Math.min(width - 140, Math.max(0, margin.left + active * slot + slot / 2 - 60)), top: 0 }}
        >
          <div className="font-medium">{monthLabel(shown.label)}</div>
          <div>{money(shown.spend)}</div>
          <div className="text-slate-500 dark:text-slate-400">{shown.orders} order{shown.orders === 1 ? '' : 's'}</div>
        </div>
      )}
    </div>
  );
}

export type IncomeSource = 'airbnb' | 'vrbo' | 'booking' | 'lease' | 'interest' | 'laundry' | 'other';
export interface InOutMonth {
  month: string; // 2026-03
  spend: number;
  income: number;
  sources: Record<IncomeSource, number>;
}

// Stacked from the bottom in this order.
const INCOME_SOURCES: { key: IncomeSource; label: string; fill: string; swatch: string }[] = [
  { key: 'airbnb', label: 'Airbnb', fill: 'fill-[var(--color-airbnb)]', swatch: 'bg-[var(--color-airbnb)]' },
  { key: 'vrbo', label: 'Vrbo', fill: 'fill-[var(--color-vrbo)]', swatch: 'bg-[var(--color-vrbo)]' },
  { key: 'booking', label: 'Booking.com', fill: 'fill-[var(--color-booking)]', swatch: 'bg-[var(--color-booking)]' },
  { key: 'lease', label: 'Leases', fill: 'fill-[var(--color-lease)]', swatch: 'bg-[var(--color-lease)]' },
  { key: 'interest', label: 'Interest', fill: 'fill-[var(--color-interest)]', swatch: 'bg-[var(--color-interest)]' },
  { key: 'laundry', label: 'Laundry', fill: 'fill-[var(--color-laundry)]', swatch: 'bg-[var(--color-laundry)]' },
  { key: 'other', label: 'Other income', fill: 'fill-[var(--color-other-income)]', swatch: 'bg-[var(--color-other-income)]' },
];

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Spending and income side by side for each month, in two colours with a legend, and
// both figures (and the difference) on hover or focus. Clicking a month opens its
// transactions.
// What was clicked: one month's spending, or its income from one source. Without a
// part, the whole month.
export type MonthPart = 'spend' | IncomeSource;

export function MonthlyInOut({ rows, onSelect }: { rows: InOutMonth[]; onSelect?: (month: string, part?: MonthPart) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
    // Again once there is a chart to measure (the data usually arrives after the first draw).
  }, [rows.length > 0]);

  // Every month in the span, so a quiet month shows as a gap.
  const months: InOutMonth[] = [];
  if (rows.length) {
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    let [y, m] = rows[0].month.split('-').map(Number);
    const [endY, endM] = rows[rows.length - 1].month.split('-').map(Number);
    while (y < endY || (y === endY && m <= endM)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      months.push(byMonth.get(key) || { month: key, spend: 0, income: 0, sources: { airbnb: 0, vrbo: 0, booking: 0, lease: 0, interest: 0, laundry: 0, other: 0 } });
      if (m === 12) {
        y++;
        m = 1;
      } else m++;
    }
  }
  if (!months.length) return <p className="py-6 text-center text-sm text-slate-500">No spending or income in this period.</p>;

  const margin = { top: 10, right: 8, bottom: 26, left: 58 };
  const height = 240;
  const slot = (width - margin.left - margin.right) / months.length;
  const plot = height - margin.top - margin.bottom;
  const top = niceMax(Math.max(...months.flatMap((m) => [m.spend, m.income]), 0));
  const low = Math.min(...months.map((m) => m.spend), 0); // refunds can outweigh a month's spending
  const bottom = low < 0 ? -niceMax(-low) : 0;
  const y = (value: number) => margin.top + plot * (1 - (value - bottom) / (top - bottom));
  const ticks = bottom < 0 ? [bottom, 0, top] : [0, top / 4, top / 2, (top * 3) / 4, top];
  const barWidth = Math.min(18, Math.max(2, (slot - 6) / 2));
  const labelEvery = Math.ceil(52 / slot);
  const shown = active === null ? null : months[active];

  // A click on one bar, or one piece of the income stack, opens just that.
  const pick = (month: string, part: MonthPart) =>
    onSelect
      ? {
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            onSelect(month, part);
          },
          style: { cursor: 'pointer' },
        }
      : {};

  const bar = (value: number, left: number, fill: string, month: string) => {
    const barTop = y(Math.max(value, 0));
    const barHeight = Math.max(value ? 1 : 0, Math.abs(y(value) - y(0)));
    if (!barHeight) return null;
    const right = left + barWidth;
    const r = Math.min(3, barHeight, barWidth / 2);
    const end = barTop + barHeight;
    const d =
      value >= 0
        ? `M${left},${end}V${barTop + r}Q${left},${barTop} ${left + r},${barTop}H${right - r}Q${right},${barTop} ${right},${barTop + r}V${end}Z`
        : `M${left},${barTop}V${end - r}Q${left},${end} ${left + r},${end}H${right - r}Q${right},${end} ${right},${end - r}V${barTop}Z`;
    return <path d={d} className={fill} {...pick(month, 'spend')} />;
  };

  // Income as a stack, one segment per platform, rounded only at the top. Segments
  // are separated by a thin gap so neighbouring colours stay apart.
  const stack = (month: InOutMonth, left: number, on: boolean) => {
    const parts = INCOME_SOURCES.map((s) => ({ ...s, value: month.sources[s.key] })).filter((p) => p.value > 0);
    let base = 0;
    return parts.map((p, i) => {
      const lowY = y(base);
      base += p.value;
      const highY = y(base);
      const last = i === parts.length - 1;
      const right = left + barWidth;
      const top = highY + (last ? 0 : 0.75);
      const h = Math.max(1, lowY - top);
      const r = last ? Math.min(3, h, barWidth / 2) : 0;
      const d = `M${left},${top + h}V${top + r}Q${left},${top} ${left + r},${top}H${right - r}Q${right},${top} ${right},${top + r}V${top + h}Z`;
      return <path key={p.key} d={d} className={p.fill} opacity={on ? 0.8 : 1} {...pick(month.month, p.key)} />;
    });
  };

  return (
    <div ref={holder} className="relative">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[var(--color-bar)]" aria-hidden /> Spending
        </span>
        {INCOME_SOURCES.filter((s) => months.some((m) => m.sources[s.key])).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`size-2.5 rounded-sm ${s.swatch}`} aria-hidden /> {s.label}
          </span>
        ))}
      </div>
      <svg width={width} height={height} role="img" aria-label="Spending and income by month" className="block">
        {ticks.map((value) => (
          <g key={value}>
            <line x1={margin.left} x2={width - margin.right} y1={y(value)} y2={y(value)} className="stroke-slate-200 dark:stroke-slate-800" />
            <text x={margin.left - 8} y={y(value) + 4} textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums dark:fill-slate-400">
              {wholeMoney(value)}
            </text>
          </g>
        ))}
        {months.map((month, index) => {
          const x = margin.left + index * slot;
          const left = x + slot / 2 - barWidth - 1;
          const [yearNumber, monthNumber] = month.month.split('-').map(Number);
          const on = active === index;
          return (
            <g
              key={month.month}
              tabIndex={0}
              role={onSelect ? 'link' : undefined}
              aria-label={`${monthLabel(month.month)}: spending ${money(month.spend)}, income ${money(month.income)}`}
              onClick={onSelect ? () => onSelect(month.month) : undefined}
              onKeyDown={onSelect ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(month.month)) : undefined}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className={`outline-none ${onSelect ? 'cursor-pointer' : ''}`}
            >
              <rect x={x} y={margin.top} width={slot} height={plot} fill="transparent" />
              {bar(month.spend, left, on ? 'fill-[var(--color-bar-hover)]' : 'fill-[var(--color-bar)]', month.month)}
              {stack(month, left + barWidth + 2, on)}
              {index % labelEvery === 0 && (
                <text x={x + slot / 2} y={height - 8} textAnchor="middle" className="fill-slate-500 text-[11px] dark:fill-slate-400">
                  {labelEvery >= 12 ? yearNumber : `${SHORT_MONTHS[monthNumber - 1]} ${String(yearNumber).slice(2)}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown && active !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md tabular-nums dark:border-slate-700 dark:bg-slate-900"
          style={{ left: Math.min(width - 160, Math.max(0, margin.left + active * slot + slot / 2 - 70)), top: 24 }}
        >
          <div className="font-medium">{monthLabel(shown.month)}</div>
          <div>Spending {money(shown.spend)}</div>
          <div>Income {money(shown.income)}</div>
          {INCOME_SOURCES.filter((s) => shown.sources[s.key]).map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 pl-2 text-slate-600 dark:text-slate-300">
              <span className={`size-2 rounded-sm ${s.swatch}`} aria-hidden /> {s.label} {money(shown.sources[s.key])}
            </div>
          ))}
          <div className="text-slate-500 dark:text-slate-400">
            {shown.income - shown.spend >= 0 ? 'Left over' : 'Short by'} {money(Math.abs(shown.income - shown.spend))}
          </div>
        </div>
      )}
    </div>
  );
}

// Ranked bars with the value in text beside each, so nothing depends on the bar alone.
// With linkFor, each row opens the matching orders or items.
export function RankBars({ rows, empty, limit = 8, linkFor }: { rows: Row[]; empty: string; limit?: number; linkFor?: (row: Row) => string }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <p className="py-4 text-center text-sm text-slate-500">{empty}</p>;
  const shown = expanded ? rows : rows.slice(0, limit);
  const max = Math.max(...rows.map((row) => Math.abs(row.spend)), 1);
  return (
    <ul className="space-y-1">
      {shown.map((row) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate" title={row.label}>
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums">
                {money(row.spend)}
                {row.orders ? <span className="text-xs text-slate-500 dark:text-slate-400"> · {row.orders}</span> : null}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-r-full bg-slate-100 dark:bg-slate-800">
              <div className="h-full rounded-r-full bg-[var(--color-bar)] group-hover:bg-[var(--color-bar-hover)]" style={{ width: `${Math.max(1, (Math.abs(row.spend) / max) * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={row.label} className="text-sm">
            {linkFor ? (
              <Link to={linkFor(row)} className="group -mx-2 block rounded-md px-2 py-1 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-600 dark:hover:bg-slate-800/60">
                {body}
              </Link>
            ) : (
              <div className="py-1">{body}</div>
            )}
          </li>
        );
      })}
      {rows.length > limit && (
        <li>
          <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="mt-1 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            {expanded ? 'Show fewer' : `and ${rows.length - limit} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

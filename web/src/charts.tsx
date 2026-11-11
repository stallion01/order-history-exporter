// Single-series charts in one hue, with values available on hover, focus and in text.
import { useEffect, useRef, useState } from 'react';
import { money, monthLabel, wholeMoney } from './format';

interface Row {
  label: string;
  spend: number;
  orders: number;
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

export function MonthlyBars({ rows }: { rows: Row[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
              aria-label={`${monthLabel(month.label)}: ${money(month.spend)}, ${month.orders} orders`}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className="outline-none"
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

// Ranked bars with the value in text beside each, so nothing depends on the bar alone.
export function RankBars({ rows, empty, limit = 8 }: { rows: Row[]; empty: string; limit?: number }) {
  if (!rows.length) return <p className="py-4 text-center text-sm text-slate-500">{empty}</p>;
  const shown = rows.slice(0, limit);
  const max = Math.max(...shown.map((row) => Math.abs(row.spend)), 1);
  return (
    <ul className="space-y-2.5">
      {shown.map((row) => (
        <li key={row.label} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 tabular-nums">
              {money(row.spend)} <span className="text-xs text-slate-500 dark:text-slate-400">· {row.orders}</span>
            </span>
          </div>
          <div className="mt-1 h-2 rounded-r-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full rounded-r-full bg-[var(--color-bar)]" style={{ width: `${Math.max(1, (Math.abs(row.spend) / max) * 100)}%` }} />
          </div>
        </li>
      ))}
      {rows.length > limit && <li className="text-xs text-slate-500">and {rows.length - limit} more</li>}
    </ul>
  );
}

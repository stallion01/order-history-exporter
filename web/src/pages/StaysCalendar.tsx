// Stays at a glance: one row per unit, one column per day, each booking a coloured bar
// from the afternoon it starts to the morning it ends, as a hotel's booking chart shows.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, TriangleAlert } from 'lucide-react';
import { useApi } from '../api';
import { businessQuery, useBusiness } from '../business';
import { MONTHS, money, plural } from '../format';
import { useFilters } from '../filters';
import { PLATFORM_NAMES, dateRange, platformColor } from '../stays';
import type { Stay, StayList } from '../stays';
import { Banner, Button, Card, Loading, cx } from '../ui';

type ColorBy = 'platform' | 'payment';

const PAYMENT_COLORS: Record<Stay['payment'], string> = {
  paid: 'var(--color-paid)',
  partial: 'var(--color-partial)',
  conflict: 'var(--color-problem)',
  missing: 'var(--color-problem)',
  due: 'var(--color-coming)',
  upcoming: 'var(--color-coming)',
  nobank: 'var(--color-unchecked)',
  none: 'var(--color-unchecked)',
};
const PAYMENT_LEGEND: [string, string][] = [
  ['var(--color-paid)', 'Paid'],
  ['var(--color-partial)', 'Part paid'],
  ['var(--color-problem)', 'No deposit or conflict'],
  ['var(--color-coming)', 'Upcoming or on its way'],
  ['var(--color-unchecked)', 'Before bank records'],
];
const PAYMENT_WORDS: Record<Stay['payment'], string> = {
  paid: 'Paid',
  partial: 'Part paid',
  conflict: 'Conflict: choose which deposit',
  missing: 'No deposit yet',
  due: 'Payout on its way',
  upcoming: 'Upcoming',
  nobank: 'Before bank records',
  none: '',
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayIndex = (date: string, first: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000);
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function StatusIcon({ payment }: { payment: Stay['payment'] }) {
  if (payment === 'paid') return <CheckCircle2 className="size-3.5 shrink-0 opacity-90" aria-hidden />;
  if (payment === 'missing' || payment === 'conflict' || payment === 'partial') return <TriangleAlert className="size-3.5 shrink-0" aria-hidden />;
  if (payment === 'due' || payment === 'upcoming') return <Clock className="size-3.5 shrink-0 opacity-80" aria-hidden />;
  return null;
}

// One month: its own card, scrolling sideways when the days don't fit.
function MonthCalendar({ month, colorBy, wide }: { month: string; colorBy: ColorBy; wide: boolean }) {
  const now = new Date();
  const [year, mon] = month.split('-').map(Number);
  const days = new Date(year, mon, 0).getDate();
  const first = `${month}-01`;
  const last = `${month}-${pad(days)}`;
  const today = iso(now);
  const { business } = useBusiness();
  const data = useApi<StayList>(`/api/stays?from=${first}&to=${last}${businessQuery(business)}`);
  const scroller = useRef<HTMLDivElement>(null);
  const loaded = Boolean(data.data);

  // On a narrow screen, start with today in view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !loaded || box.scrollWidth <= box.clientWidth || !today.startsWith(month)) return;
    const perDay = (box.scrollWidth - 144) / days;
    box.scrollLeft = Math.max(0, (Number(today.slice(8)) - 3) * perDay);
  }, [loaded, month, today, days, wide]);

  // The units: every property, plus any stay with none.
  const stays = (data.data?.stays || []).filter((s) => s.status === 'accepted');
  const units = [...(data.data?.options.properties || []).map((p) => ({ id: p.id, name: p.name }))];
  if (stays.some((s) => !s.propertyId)) units.push({ id: '', name: 'No property' });
  const byUnit = new Map<string, Stay[]>(units.map((u) => [u.id, []]));
  for (const s of stays) byUnit.get(s.propertyId || '')?.push(s);

  // Nights in this month for each unit, and how many units are taken each night.
  const nightsIn = (s: Stay) => Math.max(0, Math.min(dayIndex(s.departure, first), days) - Math.max(dayIndex(s.arrival, first), 0));
  const taken = Array.from({ length: days }, (_, i) => stays.filter((s) => dayIndex(s.arrival, first) <= i && dayIndex(s.departure, first) > i).length);
  const totalNights = stays.reduce((n, s) => n + nightsIn(s), 0);
  const unitCount = Math.max(units.length, 1);

  // Two grid columns a day, so a stay can start at midday and end at midday.
  const half = wide ? 1.2 : 0.75;
  const columns = `minmax(7.5rem, 9rem) repeat(${days * 2}, minmax(${half}rem, 1fr))`;
  const dayCell = (i: number) => ({ gridColumn: `${2 + i * 2} / span 2`, gridRow: 1 });
  const weekend = (i: number) => {
    const d = new Date(year, mon - 1, i + 1).getDay();
    return d === 0 || d === 6;
  };
  const isToday = (i: number) => `${month}-${pad(i + 1)}` === today;

  return (
    <>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className={cx('text-lg font-semibold tracking-tight', today.startsWith(month) && 'text-emerald-700 dark:text-emerald-400')}>
          {new Date(year, mon - 1, 1).toLocaleString(undefined, { month: 'long' })} {year}
        </h2>
        {data.data && (
          <span className="text-sm text-slate-600 dark:text-slate-400">
            {plural(stays.length, 'stay')} · {Math.round((totalNights / (days * unitCount)) * 100)}% of nights booked
          </span>
        )}
      </div>
      {data.error && <Banner>{data.error.message}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && (
        <Card padded={false} className="overflow-hidden">
          <div ref={scroller} className="overflow-x-auto">
            <div style={{ minWidth: `calc(9rem + ${days * half * 2}rem)` }}>
              {/* Days across the top */}
              <div className="grid border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60" style={{ gridTemplateColumns: columns }}>
                <div
                  className="sticky left-0 z-20 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400"
                  style={{ gridRow: 1, gridColumn: 1 }}
                >
                  Unit
                </div>
                {Array.from({ length: days }, (_, i) => (
                  <div
                    key={i}
                    className={cx(
                      'flex flex-col items-center py-1.5 text-[10px] leading-tight',
                      weekend(i) ? 'text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400',
                    )}
                    style={dayCell(i)}
                  >
                    <span>{WEEKDAY[new Date(year, mon - 1, i + 1).getDay()]}</span>
                    <span className={cx('mt-0.5 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold', isToday(i) && 'bg-emerald-600 text-white')}>
                      {i + 1}
                    </span>
                  </div>
                ))}
              </div>

              {/* One row per unit */}
              {units.map((u, row) => {
                const list = byUnit.get(u.id) || [];
                const nights = list.reduce((n, s) => n + nightsIn(s), 0);
                return (
                  <div
                    key={u.id || 'none'}
                    className={cx('relative grid h-14 border-b border-slate-100 last:border-b-0 dark:border-slate-800', row % 2 === 1 && 'bg-slate-50/40 dark:bg-slate-900/30')}
                    style={{ gridTemplateColumns: columns }}
                  >
                    <div
                      className="sticky left-0 z-20 flex flex-col justify-center border-r border-slate-100 bg-white px-3 dark:border-slate-800 dark:bg-slate-900"
                      style={{ gridRow: 1, gridColumn: 1 }}
                    >
                      <span className="truncate text-sm font-semibold">{u.name}</span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        {plural(nights, 'night')} · {Math.round((nights / days) * 100)}%
                      </span>
                    </div>
                    {Array.from({ length: days }, (_, i) => (
                      <div
                        key={i}
                        aria-hidden
                        className={cx(
                          'border-l border-slate-100 dark:border-slate-800/80',
                          weekend(i) && 'bg-slate-100/70 dark:bg-slate-800/40',
                          isToday(i) && 'bg-emerald-50 dark:bg-emerald-950/40',
                        )}
                        style={dayCell(i)}
                      />
                    ))}
                    {list.map((s) => {
                      const a = dayIndex(s.arrival, first);
                      const d = dayIndex(s.departure, first);
                      const startsBefore = a < 0;
                      const endsAfter = d >= days;
                      const start = startsBefore ? 2 : 3 + a * 2;
                      const end = endsAfter ? 2 + days * 2 : 3 + d * 2;
                      const color = colorBy === 'platform' ? platformColor(s.platform) : PAYMENT_COLORS[s.payment];
                      const dark = colorBy === 'platform' && s.platform === 'booking';
                      const span = end - start;
                      return (
                        <Link
                          key={s.id}
                          to={`/stays/${s.id}`}
                          title={`${s.guest || 'Guest'} · ${s.platformLabel} · ${dateRange(s.arrival, s.departure)} · ${plural(s.nights, 'night')} · ${money(s.payout)}${PAYMENT_WORDS[s.payment] ? ` · ${PAYMENT_WORDS[s.payment]}` : ''}`}
                          className={cx(
                            'relative z-10 mx-px flex h-9 min-w-0 items-center gap-1 self-center overflow-hidden px-2 text-xs font-medium shadow-sm ring-1 ring-black/5 transition hover:brightness-110 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600',
                            dark ? 'text-slate-900' : 'text-white',
                            startsBefore ? 'rounded-l-none' : 'rounded-l-full',
                            endsAfter ? 'rounded-r-none' : 'rounded-r-full',
                          )}
                          style={{ gridRow: 1, gridColumn: `${start} / ${end}`, backgroundColor: color }}
                        >
                          {colorBy === 'platform' && span >= 3 && <StatusIcon payment={s.payment} />}
                          <span className={cx('truncate', span < 3 && 'mx-auto text-[10px]')}>
                            {span >= 6
                              ? s.guest || 'Guest'
                              : span >= 3
                                ? (s.guest || 'Guest').split(' ')[0]
                                : (s.guest || 'G')
                                    .split(' ')
                                    .map((w) => w[0])
                                    .join('')
                                    .slice(0, 2)}
                          </span>
                          {span >= 8 && <span className="ml-auto shrink-0 opacity-80">{s.nights}n</span>}
                        </Link>
                      );
                    })}
                  </div>
                );
              })}

              {/* How full each night is */}
              <div className="grid border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60" style={{ gridTemplateColumns: columns }}>
                <div
                  className="sticky left-0 z-20 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400"
                  style={{ gridRow: 1, gridColumn: 1 }}
                >
                  Units booked
                </div>
                {taken.map((n, i) => (
                  <div key={i} className="flex items-center justify-center py-1.5" style={dayCell(i)} title={`${MONTHS[mon - 1]} ${i + 1}: ${n} of ${unitCount} booked`}>
                    <span
                      className={cx(
                        'flex size-6 items-center justify-center rounded text-[11px] font-semibold tabular-nums',
                        n === 0 ? 'text-slate-400' : n / unitCount >= 0.75 ? 'text-white' : 'text-emerald-900 dark:text-emerald-100',
                      )}
                      style={{ backgroundColor: n ? `color-mix(in srgb, var(--color-paid) ${Math.round(20 + (n / unitCount) * 80)}%, transparent)` : undefined }}
                    >
                      {n}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

// A computer's screen: three months, last, this and next. A phone: one.
function useWide() {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setWide(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, []);
  return wide;
}

export function StaysCalendar() {
  const filters = useFilters();
  const wide = useWide();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const month = /^\d{4}-\d{2}$/.test(filters.value('month')) ? filters.value('month') : thisMonth;
  const colorBy: ColorBy = filters.value('color') === 'payment' ? 'payment' : 'platform';
  const go = (to: string) => filters.set({ month: to === thisMonth ? '' : to });
  const months = wide ? [shiftMonth(month, -1), month, shiftMonth(month, 1)] : [month];
  const label = (m: string) => {
    const [y, n] = m.split('-').map(Number);
    return `${MONTHS[n - 1]} ${y}`;
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button onClick={() => go(shiftMonth(month, -1))} aria-label="Earlier month">
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">{wide ? `${label(months[0])} to ${label(months[2])}` : label(month)}</span>
          <Button onClick={() => go(shiftMonth(month, 1))} aria-label="Later month">
            <ChevronRight className="size-4" aria-hidden />
          </Button>
          <Button onClick={() => go(thisMonth)}>Today</Button>
        </div>
        <div className="flex rounded-md border border-slate-300 p-0.5 text-xs font-medium dark:border-slate-700" role="group" aria-label="Colour by">
          {(['platform', 'payment'] as ColorBy[]).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={colorBy === c}
              onClick={() => filters.set({ color: c === 'platform' ? '' : c })}
              className={cx('rounded px-2.5 py-1', colorBy === c ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-300')}
            >
              {c === 'platform' ? 'By platform' : 'By payment'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-6">
        {months.map((m) => (
          <section key={m}>
            <MonthCalendar month={m} colorBy={colorBy} wide={wide} />
          </section>
        ))}
      </div>

      {/* What the colours mean */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-slate-400">
        {colorBy === 'platform' ? (
          <>
            {(['airbnb', 'vrbo', 'booking', 'direct'] as const).map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-full" style={{ backgroundColor: platformColor(p) }} aria-hidden />
                {PLATFORM_NAMES[p]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="size-3.5" aria-hidden /> paid
            </span>
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="size-3.5" aria-hidden /> needs a look
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden /> to come
            </span>
          </>
        ) : (
          PAYMENT_LEGEND.map(([c, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded-full" style={{ backgroundColor: c }} aria-hidden />
              {label}
            </span>
          ))
        )}
        <span className="ml-auto">Click a stay to open it.</span>
      </div>
    </>
  );
}

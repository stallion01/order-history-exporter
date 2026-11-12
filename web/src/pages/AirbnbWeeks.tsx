// Airbnb, week by week: what Airbnb paid out (from Hospitable) against the deposits
// linked to it, so a week that doesn't add up stands out.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { money, plural } from '../format';
import { longDate, shortDate } from '../stays';
import type { AirbnbWeek, AirbnbWeeks } from '../stays';
import { Banner, Card, Empty, Loading, Stat, cx } from '../ui';

const WEEK_LABELS: Record<AirbnbWeek['status'], [string, string]> = {
  paid: ['All deposited', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'],
  conflict: ['Conflict', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'],
  missing: ['Deposit missing', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'],
  extra: ['Unmatched deposit', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'],
  due: ['On its way', 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'],
  nobank: ['Before bank records', 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'],
};
const ITEM_LABELS: Record<string, string> = {
  paid: 'Deposited',
  conflict: 'Conflict: could be paid more than one way',
  missing: 'No deposit found',
  due: 'On its way',
  nobank: 'Before your bank records start',
};
const toCheck = (w: AirbnbWeek) => w.status === 'conflict' || w.status === 'missing' || w.status === 'extra';
const dayLink = (date: string) => `/transactions?preset=custom&from=${date}&to=${date}`;

function Week({ week: w }: { week: AirbnbWeek }) {
  const [label, tone] = WEEK_LABELS[w.status];
  return (
    <details className="group border-t border-slate-100 first:border-t-0 dark:border-slate-800" open={toCheck(w)}>
      <summary className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-slate-50 sm:grid-cols-[10rem_1fr_auto] dark:hover:bg-slate-800/60">
        <span className="font-medium">Week of {shortDate(w.week)}</span>
        <span className="order-last col-span-2 text-xs text-slate-500 sm:order-none sm:col-span-1 dark:text-slate-400">
          Paid out {money(w.expected)} · deposited {money(w.matched)}
          {w.unmatched ? ` · ${money(w.unmatched)} not found` : ''}
          {w.unclaimed ? ` · ${money(w.unclaimed)} in deposits not matched` : ''}
        </span>
        <span className={cx('justify-self-end rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone)}>{label}</span>
      </summary>
      <ul className="space-y-2 px-4 pb-4 text-sm">
        {w.items.map((i) => (
          <li key={`${i.kind}-${i.id}`} className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {i.kind === 'payout' ? 'Airbnb payout' : 'Expected payout'} {longDate(i.date)}
              </span>
              <span className="font-medium tabular-nums">{money(i.amount)}</span>
            </div>
            <ul className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {i.stays.map((s, n) => (
                <li key={n} className="flex justify-between gap-2">
                  {s.id ? (
                    <Link to={`/stays/${s.id}`} className="hover:underline">
                      {s.guest}
                    </Link>
                  ) : (
                    <span>{s.guest}</span>
                  )}
                  <span className="tabular-nums">{money(s.amount)}</span>
                </li>
              ))}
            </ul>
            <div
              className={cx(
                'mt-2 text-xs',
                i.status === 'paid'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : i.status === 'conflict'
                    ? 'text-red-700 dark:text-red-400'
                    : i.status === 'missing'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400',
              )}
            >
              {i.deposit ? (
                <Link to={dayLink(i.deposit.posted)} className="hover:underline">
                  Deposited {longDate(i.deposit.posted)}
                  {Math.round(i.deposit.amount * 100) !== Math.round(i.amount * 100) ? `, as part of ${money(i.deposit.amount)}` : ''}
                </Link>
              ) : i.stays[0]?.id && i.status === 'conflict' ? (
                <Link to={`/stays/${i.stays[0].id}`} className="font-medium underline">
                  {ITEM_LABELS.conflict}: choose
                </Link>
              ) : (
                ITEM_LABELS[i.status] || i.status
              )}
            </div>
          </li>
        ))}
        {w.extras.map((e) => (
          <li key={e.id} className="rounded-md border border-dashed border-amber-300 p-3 dark:border-amber-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link to={dayLink(e.posted)} className="hover:underline">
                Airbnb deposit {longDate(e.posted)}
              </Link>
              <span className="font-medium tabular-nums">{money(e.amount)}</span>
            </div>
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {e.conflict ? 'Adds up to more than one set of payouts: open one of them to choose.' : 'Not matched to any payout or stay.'}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AirbnbWeeksView({ year }: { year: string }) {
  const data = useApi<AirbnbWeeks>(`/api/stays/airbnb-weeks?year=${year}`);
  const [onlyToCheck, setOnlyToCheck] = useState(false);
  if (data.error) return <Banner>{data.error.message}</Banner>;
  if (!data.data) return <Loading />;
  const { weeks, totals } = data.data;
  const shown = onlyToCheck ? weeks.filter(toCheck) : weeks;
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Airbnb paid out" value={money(totals.expected)} hint={`${plural(totals.weeks, 'week')} in ${year}`} />
        <Stat label="Found in the bank" value={money(totals.matched)} />
        <Stat
          label="Not found"
          value={money(Math.round((totals.expected - totals.matched) * 100) / 100)}
          hint={totals.bankStart ? `Bank records start ${longDate(totals.bankStart)}` : undefined}
        />
        <Stat label="Weeks to check" value={totals.weeksToCheck} hint={totals.unclaimed ? `${money(totals.unclaimed)} in Airbnb deposits not matched` : 'No unmatched deposits'} />
      </div>
      <label className="mb-3 inline-flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-700" checked={onlyToCheck} onChange={(e) => setOnlyToCheck(e.target.checked)} />
        Only weeks to check
      </label>
      <Card padded={false}>
        {shown.length ? shown.map((w) => <Week key={w.week} week={w} />) : <Empty>{onlyToCheck ? 'Every week adds up.' : 'No Airbnb payouts this year.'}</Empty>}
      </Card>
    </>
  );
}

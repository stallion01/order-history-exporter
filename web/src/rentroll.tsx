// Rent collection at a glance: each unit's rent month by month, rent collected
// against rent due, leases coming to an end, and a reminder before they do.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useApi } from './api';
import { money, monthLabel, wholeMoney } from './format';
import { dayText } from './leases';
import type { Lease, LeaseList, RentRoll, RollState } from './leases';
import { Button, Card, Empty, cx } from './ui';

// How far ahead the reminder starts, in days.
export const EXPIRY_WARNING_DAYS = 45;

type Shown = RollState | 'cash';
const STATES: { key: Shown; label: string; tone: string }[] = [
  { key: 'paid', label: 'Paid', tone: 'bg-emerald-500 text-white' },
  { key: 'partial', label: 'Part paid', tone: 'bg-amber-400 text-amber-950' },
  { key: 'due', label: 'Due this month', tone: 'bg-sky-400 text-sky-950' },
  { key: 'missed', label: 'Not paid', tone: 'bg-red-500 text-white' },
  { key: 'cash', label: 'Cash, not recorded', tone: 'bg-violet-300 text-violet-950 dark:bg-violet-400' },
  { key: 'vacant', label: 'No lease', tone: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500' },
];
const TONE = Object.fromEntries(STATES.map((s) => [s.key, s.tone])) as Record<Shown, string>;
const LABEL = Object.fromEntries(STATES.map((s) => [s.key, s.label])) as Record<Shown, string>;

export function RentRollCard({ query }: { query: string }) {
  const data = useApi<RentRoll>(`/api/leases/rent-roll?${query}`);
  const roll = data.data;
  if (!roll) return null;
  if (!roll.units.length)
    return (
      <Card title="Rent collection" className="mt-5">
        <Empty>Rent shows here once a lease has its monthly rent.</Empty>
      </Card>
    );
  const shown = (state: RollState, cash: boolean): Shown => (cash && (state === 'missed' || state === 'due') ? 'cash' : state);
  return (
    <Card title="Rent collection, last 12 months" className="mt-5">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white pr-2 text-left font-medium text-slate-500 dark:bg-slate-900">Unit</th>
              {roll.months.map((m) => (
                <th key={m} className="min-w-9 font-medium text-slate-500" scope="col">
                  {monthLabel(m, true).split(' ')[0]}
                  {m.endsWith('-01') && <div className="font-normal text-slate-400">{m.slice(2, 4)}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roll.units.map((u) => (
              <tr key={u.unit}>
                <th scope="row" className="sticky left-0 whitespace-nowrap bg-white pr-2 text-left font-medium dark:bg-slate-900">
                  {u.unit}
                  {u.cash && <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-normal text-violet-800 dark:bg-violet-900/60 dark:text-violet-200">cash</span>}
                </th>
                {u.cells.map((c) => {
                  const state = shown(c.state, u.cash);
                  const tenant = c.leases.map((l) => l.tenant).join(', ');
                  const title = `${u.unit}, ${monthLabel(c.month)}: ${LABEL[state]}${c.expected ? ` (${money(c.paid)} of ${money(c.expected)})` : ''}${tenant ? ` · ${tenant}` : ''}`;
                  const box = (
                    <span className={cx('flex h-7 items-center justify-center rounded text-[10px] font-semibold tabular-nums', TONE[state])}>
                      {state === 'partial' ? `${Math.round((c.paid / c.expected) * 100)}%` : ''}
                    </span>
                  );
                  return (
                    <td key={c.month} title={title}>
                      {c.leases.length ? (
                        <Link to={`/leases/${c.leases[c.leases.length - 1].id}`} aria-label={title} className="block hover:opacity-80">
                          {box}
                        </Link>
                      ) : (
                        box
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        {STATES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={cx('size-3 rounded-sm', s.tone)} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      <CollectedChart totals={roll.totals} />
    </Card>
  );
}

// Rent due each month as a pale bar, with rent received drawn over it.
function CollectedChart({ totals }: { totals: RentRoll['totals'] }) {
  const top = Math.max(1, ...totals.flatMap((t) => [t.expected, t.collected]));
  const due = totals.reduce((n, t) => n + t.expected, 0);
  const got = totals.reduce((n, t) => n + t.collected, 0);
  return (
    <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Rent collected against rent due</h3>
        <span className="text-xs text-slate-600 dark:text-slate-400">
          {wholeMoney(got)} of {wholeMoney(due)} over 12 months{due > 0 && ` (${Math.round((got / due) * 100)}%)`}
        </span>
      </div>
      <div className="mt-3 flex h-36 items-end gap-1" role="img" aria-label="Rent collected against rent due, by month">
        {totals.map((t) => (
          <div key={t.month} className="flex h-full flex-1 flex-col justify-end" title={`${monthLabel(t.month)}: ${money(t.collected)} collected of ${money(t.expected)} due`}>
            <div className="relative w-full" style={{ height: `${(Math.max(t.expected, t.collected) / top) * 100}%` }}>
              <div className="absolute inset-x-0 bottom-0 rounded-t bg-slate-200 dark:bg-slate-700" style={{ height: `${t.expected ? (t.expected / Math.max(t.expected, t.collected)) * 100 : 0}%` }} />
              <div
                className="absolute inset-x-1 bottom-0 rounded-t bg-emerald-500"
                style={{ height: `${t.collected ? (t.collected / Math.max(t.expected, t.collected)) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-center text-[10px] text-slate-500">
        {totals.map((t) => (
          <span key={t.month} className="flex-1">
            {monthLabel(t.month, true).split(' ')[0]}
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-600 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-slate-200 dark:bg-slate-700" aria-hidden /> Due
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-emerald-500" aria-hidden /> Collected
        </span>
      </div>
    </div>
  );
}

const daysText = (days: number | null) => (days === null ? 'Open-ended' : days < 0 ? `Ended ${-days} days ago` : days === 0 ? 'Ends today' : `${days} day${days === 1 ? '' : 's'} left`);
const daysTone = (days: number | null) =>
  days === null ? 'text-slate-500' : days <= EXPIRY_WARNING_DAYS ? 'text-red-700 dark:text-red-400' : days <= 90 ? 'text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400';

// Active and upcoming leases by end date, soonest first.
export function ExpiryList({ leases }: { leases: Lease[] }) {
  const rows = leases.filter((l) => l.status !== 'ended').sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
  if (!rows.length) return null;
  return (
    <Card title="Lease end dates" className="mt-5" padded={false}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((l) => (
          <li key={l.id}>
            <Link to={`/leases/${l.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <span className="min-w-0">
                <span className="font-medium">{l.unit}</span> <span className="text-slate-600 dark:text-slate-400">{l.tenant}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-xs text-slate-500">{l.end ? dayText(l.end) : '–'}</span>
                <span className={cx('block text-xs font-semibold', daysTone(l.daysLeft))}>{daysText(l.daysLeft)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// A pop-up, anywhere in the app, when a lease ends within 45 days. Each lease
// and end date is dismissed on its own; "Remind me in a week" brings it back.
const KEY = (l: Lease) => `lease-expiry:${l.id}:${l.end}`;
function snoozed(l: Lease) {
  try {
    const value = localStorage.getItem(KEY(l));
    return value === 'done' || (value !== null && Number(value) > Date.now());
  } catch {
    return false;
  }
}
function remember(leases: Lease[], value: string) {
  try {
    for (const l of leases) localStorage.setItem(KEY(l), value);
  } catch {
    // Not saved; the reminder shows again next time.
  }
}

export function ExpiryWarning() {
  const data = useApi<LeaseList>('/api/leases');
  const [closed, setClosed] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const due = (data.data?.expiring ?? []).filter((l) => !snoozed(l));
  const open = due.length > 0 && !closed;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const close = (value: string) => {
    remember(due, value);
    setClosed(true);
  };
  if (!due.length) return null;
  return (
    <dialog
      ref={ref}
      onCancel={() => setClosed(true)}
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <CalendarClock className="size-5 text-amber-600" aria-hidden />
          {due.length === 1 ? 'A lease ends soon' : `${due.length} leases end soon`}
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {due.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3">
              <Link to={`/leases/${l.id}`} onClick={() => setClosed(true)} className="min-w-0 hover:underline">
                <span className="font-medium">{l.unit}</span> <span className="text-slate-600 dark:text-slate-400">{l.tenant}</span>
              </Link>
              <span className="shrink-0 text-right text-xs">
                <span className="block text-slate-500">{dayText(l.end)}</span>
                <span className={cx('block font-semibold', daysTone(l.daysLeft))}>{daysText(l.daysLeft)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Time to renew, or to list the unit. Changing the end date on the lease starts a new reminder.</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
        <Button onClick={() => close(String(Date.now() + 7 * 86_400_000))}>Remind me in a week</Button>
        <Button variant="primary" onClick={() => close('done')}>
          Got it
        </Button>
      </div>
    </dialog>
  );
}

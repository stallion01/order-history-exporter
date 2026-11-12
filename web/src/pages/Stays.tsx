// Stays: every reservation from Hospitable, with the guest, the property, the money
// and whether the deposit that paid for it has turned up in the bank.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { post, useApi } from '../api';
import { money, monthLabel, plural, whole } from '../format';
import { useFilters } from '../filters';
import { PLATFORM_NAMES, dateRange, platformColor, shortDate } from '../stays';
import type { Stay, StayList } from '../stays';
import { AirbnbWeeksView } from './AirbnbWeeks';
import { Banner, Button, Card, Empty, Field, Input, Loading, MultiSelect, PageHeader, Select, Stat, TD, TH, TR, cx } from '../ui';

type View = 'all' | 'upcoming' | 'unpaid' | 'conflicts' | 'cancelled' | 'weeks';

export function PlatformBadge({ platform, label }: { platform: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: platformColor(platform) }} aria-hidden />
      {label || PLATFORM_NAMES[platform] || platform}
    </span>
  );
}

function Payment({ stay }: { stay: Stay }) {
  if (stay.payment === 'paid')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400" title="The deposit is linked">
        <CheckCircle2 className="size-3.5" aria-hidden />
        {stay.depositDate ? `Paid ${shortDate(stay.depositDate)}` : 'Paid'}
      </span>
    );
  if (stay.payment === 'missing')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400" title="No deposit linked yet">
        <TriangleAlert className="size-3.5" aria-hidden />
        No deposit yet
      </span>
    );
  if (stay.payment === 'conflict')
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400"
        title="A deposit could be this stay's in more than one way: open it to choose"
      >
        <TriangleAlert className="size-3.5" aria-hidden />
        Conflict
      </span>
    );
  if (stay.payment === 'upcoming' || stay.payment === 'due')
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
        title={stay.payment === 'due' ? `Payout expected ${shortDate(stay.expectedOn)}` : undefined}
      >
        <Clock className="size-3.5" aria-hidden />
        {stay.payment === 'due' ? 'On its way' : 'Upcoming'}
      </span>
    );
  if (stay.payment === 'nobank')
    return (
      <span className="text-xs text-slate-500 dark:text-slate-400" title="Paid out before your bank records start, so it can't be checked">
        Before bank records
      </span>
    );
  return <span className="text-xs text-slate-500 capitalize dark:text-slate-400">{stay.status === 'accepted' ? '' : stay.status}</span>;
}

function StayRow({ stay, search }: { stay: Stay; search: string }) {
  return (
    <li>
      <Link to={`/stays/${stay.id}${search}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <div className="min-w-0">
          <div className="truncate font-medium">{stay.guest || 'Guest'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
            <PlatformBadge platform={stay.platform} label={stay.platformLabel} />
            <span>{stay.property || 'Unknown property'}</span>
            <span>
              {dateRange(stay.arrival, stay.departure)} · {plural(stay.nights, 'night')}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className={cx('font-medium tabular-nums', stay.status !== 'accepted' && 'text-slate-400 line-through')}>{money(stay.payout)}</div>
          <Payment stay={stay} />
        </div>
      </Link>
    </li>
  );
}

export function Stays() {
  const filters = useFilters();
  const thisYear = String(new Date().getFullYear());
  const view = (filters.value('view') || 'all') as View;
  // A year is chosen by default, so the totals mean something; "all" shows every year.
  const yearChoice = filters.value('year') || (view === 'upcoming' ? 'all' : thisYear);
  const [search, setSearch] = useState(filters.value('q'));
  const deposit = filters.value('deposit');

  const query = new URLSearchParams();
  // The weekly view has its own data; the list call still brings the options and status.
  if (view !== 'all' && view !== 'weeks') query.set('view', view);
  if (yearChoice !== 'all' && !deposit) query.set('year', yearChoice);
  for (const p of filters.values('property')) query.append('property', p);
  for (const p of filters.values('platform')) query.append('platform', p);
  if (filters.value('q')) query.set('q', filters.value('q'));
  if (deposit) query.set('deposit', deposit);
  const list = useApi<StayList>(`/api/stays?${query}`);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'info' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.value('q')) filters.set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function syncNow() {
    setBusy(true);
    setMessage(null);
    try {
      const { result } = await post<{
        result: {
          stays: number;
          newStays: number;
          linked: number;
          errors: string[];
        };
      }>('/api/stays/sync');
      setMessage(
        result.errors.length
          ? { tone: 'error', text: result.errors.join(' ') }
          : {
              tone: 'info',
              text: `Up to date: ${plural(result.stays, 'stay')}${result.newStays ? `, ${whole(result.newStays)} new` : ''}${result.linked ? `, ${plural(result.linked, 'deposit')} newly linked` : ''}.`,
            },
      );
      list.reload();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
    setBusy(false);
  }

  const data = list.data;
  const status = data?.status;
  const params = new URLSearchParams(filters.params);
  const rowSearch = params.size ? `?${params}` : '';

  // Grouped by the month the guests arrive.
  const months: { key: string; stays: Stay[] }[] = [];
  for (const s of data?.stays || []) {
    const key = s.arrival.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.key === key) last.stays.push(s);
    else months.push({ key, stays: [s] });
  }

  const tabs: [View, string][] = [
    ['all', 'All'],
    ['upcoming', 'Upcoming'],
    ['unpaid', 'No deposit yet'],
    ['conflicts', 'Conflicts'],
    ['weeks', 'Airbnb by week'],
    ['cancelled', 'Cancelled'],
  ];
  const years = [...new Set([thisYear, ...(data?.options.years || [])])].sort().reverse();

  return (
    <>
      <PageHeader
        title="Stays"
        description="Reservations from Hospitable, with each guest and the bank deposit that paid for the stay."
        actions={
          status?.connected && (
            <Button busy={busy} onClick={syncNow}>
              <RefreshCw className="size-4" aria-hidden />
              Check Hospitable now
            </Button>
          )
        }
      />
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {status && !status.connected && (
        <Banner tone="warning">
          {status.stays ? 'Hospitable is not connected, so these stays are not being updated.' : 'Connect Hospitable to bring in your stays.'} Add a Hospitable token in{' '}
          <Link to="/settings" className="font-medium underline">
            Settings
          </Link>
          .
        </Banner>
      )}
      {status?.errors.length ? <Banner>The last check of Hospitable had a problem: {status.errors.join(' ')}</Banner> : null}
      {deposit && (
        <Banner tone="info">
          Stays paid for by one deposit.{' '}
          <button type="button" className="font-medium underline" onClick={() => filters.set({ deposit: '' })}>
            Show all stays
          </button>
        </Banner>
      )}

      {data && view !== 'cancelled' && view !== 'weeks' && !deposit && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Stays" value={whole(data.totals.stays)} hint={plural(data.totals.nights, 'night')} />
          <Stat label="Payouts" value={money(data.totals.payout)} hint={`Guests paid ${money(data.totals.guestTotal)}`} />
          <Stat
            label="Deposits found"
            value={money(data.totals.paid)}
            hint={
              data.totals.noBankCount
                ? `${money(data.totals.noBank)} from ${plural(data.totals.noBankCount, 'stay')} before your bank records${data.totals.bankStart ? ` (${shortDate(data.totals.bankStart)})` : ''}`
                : data.totals.due
                  ? `${money(data.totals.due)} on its way`
                  : undefined
            }
          />
          <Stat
            label="No deposit yet"
            value={money(data.totals.missing)}
            hint={
              data.totals.missingCount || data.totals.conflictCount ? (
                <span className="flex flex-wrap gap-x-2">
                  {data.totals.missingCount > 0 && (
                    <button type="button" className="underline" onClick={() => filters.set({ view: 'unpaid' })}>
                      {plural(data.totals.missingCount, 'stay')} to look at
                    </button>
                  )}
                  {data.totals.conflictCount > 0 && (
                    <button type="button" className="font-medium text-red-700 underline dark:text-red-400" onClick={() => filters.set({ view: 'conflicts' })}>
                      {plural(data.totals.conflictCount, 'conflict')}
                    </button>
                  )}
                </span>
              ) : (
                'Nothing missing'
              )
            }
          />
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Which stays">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => filters.set({ view: value === 'all' ? '' : value, deposit: '' })}
            className={cx(
              'rounded-full px-3 py-1.5 text-sm font-medium',
              view === value
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <form className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <Field label={view === 'weeks' ? 'Year' : 'Year of arrival'}>
          <Select
            value={yearChoice}
            onChange={(e) =>
              filters.set({
                year: e.target.value === thisYear && view !== 'upcoming' ? '' : e.target.value,
              })
            }
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
            {view !== 'weeks' && <option value="all">All years</option>}
          </Select>
        </Field>
        {view !== 'weeks' && (
          <>
            <MultiSelect
              label="Property"
              allLabel="All properties"
              options={(data?.options.properties || []).map((p): [string, string] => [p.id, p.name])}
              selected={filters.values('property')}
              onChange={(next) => filters.set({ property: next })}
            />
            <MultiSelect
              label="Booked through"
              allLabel="All platforms"
              options={(data?.options.platforms || []).map((p): [string, string] => [p, PLATFORM_NAMES[p] || p])}
              selected={filters.values('platform')}
              onChange={(next) => filters.set({ platform: next })}
            />
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
                <Input type="search" className="pl-8" placeholder="Guest, phone or code" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </Field>
          </>
        )}
      </form>

      {list.error && <Banner>{list.error.message}</Banner>}
      {view === 'weeks' && <AirbnbWeeksView year={yearChoice === 'all' ? thisYear : yearChoice} />}
      {!data && list.loading && <Loading />}

      {data && view !== 'cancelled' && view !== 'weeks' && !deposit && data.byProperty.length > 1 && (
        <Card title="By property" className="mb-5" padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH}>Property</th>
                  <th className={cx(TH, 'text-right')}>Stays</th>
                  <th className={cx(TH, 'text-right')}>Nights</th>
                  {yearChoice !== 'all' && view === 'all' && <th className={cx(TH, 'text-right')}>Booked</th>}
                  <th className={cx(TH, 'text-right')}>Average night</th>
                  <th className={cx(TH, 'text-right')}>Payouts</th>
                </tr>
              </thead>
              <tbody>
                {data.byProperty.map((p) => (
                  <tr key={p.propertyId || 'none'} className={TR}>
                    <td className={TD}>
                      {p.propertyId ? (
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() =>
                            filters.set({
                              property: [p.propertyId as string],
                            })
                          }
                        >
                          {p.property}
                        </button>
                      ) : (
                        p.property
                      )}
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums')}>{whole(p.stays)}</td>
                    <td className={cx(TD, 'text-right tabular-nums')}>{whole(p.nights)}</td>
                    {yearChoice !== 'all' && view === 'all' && (
                      <td className={cx(TD, 'text-right tabular-nums')} title="Nights booked out of the nights in the year">
                        {p.occupancy === null ? '–' : `${p.occupancy}%`}
                      </td>
                    )}
                    <td className={cx(TD, 'text-right tabular-nums')}>{money(p.averageNightly)}</td>
                    <td className={cx(TD, 'text-right font-medium tabular-nums')}>{money(p.payout)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data && view !== 'weeks' && !data.stays.length && (
        <Card>
          <Empty>{status?.stays ? 'No stays match.' : 'No stays yet.'}</Empty>
        </Card>
      )}
      <div className="space-y-5">
        {view !== 'weeks' &&
          months.map((m) => (
            <Card
              key={m.key}
              padded={false}
              title={monthLabel(m.key)}
              actions={
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {plural(m.stays.length, 'stay')} · {money(m.stays.filter((s) => s.status === 'accepted').reduce((n, s) => n + (s.payout || 0), 0))}
                </span>
              }
            >
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {m.stays.map((s) => (
                  <StayRow key={s.id} stay={s} search={rowSearch} />
                ))}
              </ul>
            </Card>
          ))}
      </div>
    </>
  );
}

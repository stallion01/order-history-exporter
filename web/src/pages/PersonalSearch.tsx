// Searching one's own payments in My money: by name, description or amount, within a
// time frame and in one group if wanted, newest first. Payments found can be moved to
// another group together. A family login searches and moves only their own.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { post, useApi } from '../api';
import { money } from '../format';
import { Banner, Button, Card, Input, Loading, cx } from '../ui';
import { PaymentSheet, info, moveTo, setGroupNames } from './Personal';
import type { SheetTx } from './Personal';

interface Result {
  id: number;
  posted: string;
  amount: number;
  name: string;
  description: string;
  account: string;
  flow: 'in' | 'out' | 'move';
  group: string;
  family: boolean;
}
interface Found {
  results: Result[];
  total: number;
  names: Record<string, string>;
  customGroups: { key: string; name: string }[];
}

const dateLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Time frames, each as from and to dates counted from today.
const FRAMES: { key: string; label: string; range?: () => [string, string] }[] = [
  { key: '', label: 'Any time' },
  {
    key: 'month',
    label: 'This month',
    range: () => {
      const d = new Date();
      return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), iso(d)];
    },
  },
  {
    key: 'last-month',
    label: 'Last month',
    range: () => {
      const d = new Date();
      return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
    },
  },
  {
    key: '3-months',
    label: 'Last 3 months',
    range: () => {
      const d = new Date();
      return [iso(new Date(d.getFullYear(), d.getMonth() - 2, 1)), iso(d)];
    },
  },
  {
    key: 'year',
    label: 'This year',
    range: () => {
      const d = new Date();
      return [`${d.getFullYear()}-01-01`, iso(d)];
    },
  },
  {
    key: 'last-year',
    label: 'Last year',
    range: () => {
      const y = new Date().getFullYear() - 1;
      return [`${y}-01-01`, `${y}-12-31`];
    },
  },
  { key: 'custom', label: 'Pick dates' },
];

const selectClass = 'h-10 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-900';

export function PersonalSearch({ member = false }: { member?: boolean }) {
  const [open, setOpen] = useState<SheetTx | null>(null);
  const [params, setParams] = useSearchParams();
  const person = params.get('person');
  const [text, setText] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(text.trim());
  const frame = params.get('when') ?? '';
  const group = params.get('group') ?? '';
  const [from, to] = FRAMES.find((f) => f.key === frame)?.range?.() ?? (frame === 'custom' ? [params.get('from') ?? '', params.get('to') ?? ''] : ['', '']);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  // Searches a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const set = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if ((params.get('q') ?? '') !== query) set({ q: query || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const asked = Boolean(query || group || from || to);
  const search = new URLSearchParams();
  if (query) search.set('q', query);
  if (group) search.set('group', group);
  if (from) search.set('from', from);
  if (to) search.set('to', to);
  if (person) search.set('person', person);
  // Asked even with nothing to search for, for the group names.
  const url = `/api/personal/search?${search}`;
  const { data, error, loading, reload } = useApi<Found>(url);
  if (data) setGroupNames(data.names, data.customGroups);
  const results = useMemo(() => (asked ? (data?.results ?? []) : []), [asked, data]);
  // A choice of payments is kept only while they're still found.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => results.some((r) => r.id === id))));
  }, [results]);

  const movable = results.filter((r) => !r.family);
  const spent = results.filter((r) => r.flow === 'out').reduce((s, r) => s - r.amount, 0);
  const allPicked = movable.length > 0 && movable.every((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const move = async () => {
    if (!target || !selected.size) return;
    setBusy(true);
    setMessage(null);
    try {
      const { moved } = await post<{ moved: number }>('/api/personal/group/bulk', { transactionIds: [...selected], group: target, person: person ? Number(person) : undefined });
      setMessage({ tone: 'info', text: `Moved ${moved} ${moved === 1 ? 'payment' : 'payments'} to ${info(target).label}.` });
      setSelected(new Set());
      reload();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx(selected.size > 0 && 'pb-20')}>
      <Link to={`/personal${person ? `?person=${person}` : ''}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> My money
      </Link>
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Search</h1>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
        <span className="sr-only">Search your payments</span>
        <Input type="search" inputMode="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="A place, a word, or an amount" className="h-12 w-full pl-10 text-base" />
      </label>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs text-slate-500">
          When
          <select className={selectClass} value={frame} onChange={(e) => set({ when: e.target.value || null, from: null, to: null })}>
            {FRAMES.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-slate-500">
          Group
          <select className={selectClass} value={group} onChange={(e) => set({ group: e.target.value || null })}>
            <option value="">Every group</option>
            {moveTo().map((k) => (
              <option key={k} value={k}>
                {info(k).label}
              </option>
            ))}
          </select>
        </label>
        {frame === 'custom' && (
          <>
            <label className="grid gap-1 text-xs text-slate-500">
              From
              <Input type="date" value={from} max={to || undefined} onChange={(e) => set({ from: e.target.value || null })} className="h-10" />
            </label>
            <label className="grid gap-1 text-xs text-slate-500">
              To
              <Input type="date" value={to} min={from || undefined} onChange={(e) => set({ to: e.target.value || null })} className="h-10" />
            </label>
          </>
        )}
      </div>
      {error && <Banner>{error.message}</Banner>}
      {message && <Banner tone={message.tone === 'info' ? 'info' : undefined}>{message.text}</Banner>}
      {!asked ? (
        <p className="py-8 text-center text-sm text-slate-500">Search every payment in your accounts, such as MTA, Uber or 12.50, or pick a time and a group.</p>
      ) : loading && !data ? (
        <Loading />
      ) : !results.length ? (
        <p className="py-8 text-center text-sm text-slate-500">Nothing matches.</p>
      ) : (
        <Card padded={false}>
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
            <input
              type="checkbox"
              className="size-5"
              aria-label="Choose every payment shown"
              checked={allPicked}
              disabled={!movable.length}
              onChange={() => setSelected(allPicked ? new Set() : new Set(movable.map((r) => r.id)))}
            />
            <span className="flex-1">
              {data && data.total > results.length ? `The newest ${results.length} of ${data.total}` : `${results.length} ${results.length === 1 ? 'payment' : 'payments'}`}
              {spent > 0 && <> · {money(spent)} spent</>}
            </span>
          </div>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {results.map((r) => {
              const gi = info(r.group);
              return (
                <li key={r.id}>
                  <div className={cx('flex items-center gap-3 px-4 py-1', selected.has(r.id) && 'bg-emerald-50 dark:bg-emerald-950/40')}>
                    <label className="-my-1 -ml-2 flex shrink-0 cursor-pointer items-center self-stretch py-3 pl-2">
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={selected.has(r.id)}
                        disabled={r.family}
                        onChange={() => toggle(r.id)}
                        aria-label={`Choose ${r.name} on ${dateLabel(r.posted)}`}
                      />
                    </label>
                    <button type="button" onClick={() => setOpen(r)} className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{r.name}</div>
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                          <span className="size-2 shrink-0 rounded-full" style={{ background: gi.colour }} aria-hidden />
                          <span className="truncate">
                            {dateLabel(r.posted)} · {gi.label} · {r.account}
                          </span>
                        </div>
                      </div>
                      <span className={cx('shrink-0 tabular-nums', r.amount > 0 && 'text-emerald-600')}>{money(-r.amount)}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {open && <PaymentSheet tx={open} member={member} person={person ? Number(person) : null} onClose={() => setOpen(null)} onMoved={reload} />}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-30 border-t border-slate-200 bg-white px-4 py-3 shadow-lg md:bottom-0 md:left-60 dark:border-slate-700 dark:bg-slate-900">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="shrink-0 text-sm font-medium">{selected.size} chosen</span>
            <select className={cx(selectClass, 'min-w-0 flex-1')} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Group to move them to">
              <option value="">Move to…</option>
              {moveTo().map((k) => (
                <option key={k} value={k}>
                  {info(k).label}
                </option>
              ))}
            </select>
            <Button onClick={move} disabled={busy || !target}>
              Move
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

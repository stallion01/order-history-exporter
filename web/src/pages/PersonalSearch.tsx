// Searching one's own payments in My money: by name, description or amount, newest
// first, with the group each is in. A family login searches only their own.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { useApi } from '../api';
import { money } from '../format';
import { Banner, Card, Input, Loading, cx } from '../ui';
import { info, setGroupNames } from './Personal';

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

const dateLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function PersonalSearch() {
  const [params, setParams] = useSearchParams();
  const person = params.get('person');
  const [text, setText] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(text.trim());
  // Searches a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (query) next.set('q', query);
    else next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const url = query ? `/api/personal/search?q=${encodeURIComponent(query)}${person ? `&person=${person}` : ''}` : null;
  const { data, error, loading } = useApi<{ results: Result[]; names: Record<string, string> }>(url);
  if (data) setGroupNames(data.names);
  const results = query ? (data?.results ?? []) : [];
  const total = results.filter((r) => r.flow === 'out').reduce((s, r) => s - r.amount, 0);

  return (
    <>
      <Link to={`/personal${person ? `?person=${person}` : ''}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> My money
      </Link>
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Search</h1>
      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
        <span className="sr-only">Search your payments</span>
        <Input type="search" inputMode="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="A place, a word, or an amount" className="h-12 w-full pl-10 text-base" />
      </label>
      {error && <Banner>{error.message}</Banner>}
      {!query ? (
        <p className="py-8 text-center text-sm text-slate-500">Search every payment in your accounts, such as MTA, Uber or 12.50.</p>
      ) : loading && !data ? (
        <Loading />
      ) : !results.length ? (
        <p className="py-8 text-center text-sm text-slate-500">Nothing matches “{query}”.</p>
      ) : (
        <Card padded={false}>
          <p className="border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
            {results.length === 100 ? 'The newest 100' : `${results.length} ${results.length === 1 ? 'payment' : 'payments'}`}
            {total > 0 && <> · {money(total)} spent</>}
          </p>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {results.map((r) => {
              const gi = info(r.group);
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: gi.colour }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={r.description}>
                      {r.name}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {dateLabel(r.posted)} · {gi.label} · {r.account}
                    </div>
                  </div>
                  <span className={cx('shrink-0 tabular-nums', r.amount > 0 && 'text-emerald-600')}>{money(-r.amount)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}

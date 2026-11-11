// Filters live in the address bar, so a filtered view can be bookmarked or shared,
// and the back button undoes a change.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { isoDaysAgo } from './format';
import { Field, Input, Select } from './ui';

export interface Meta {
  stores: { store: string; name: string }[];
  payments: string[];
  zips: string[];
  years: string[];
  categories: { name: string; scheduleC: string | null; scheduleE: string | null }[];
}

const KEYS = ['preset', 'from', 'to', 'store', 'category', 'zip', 'payment', 'q'] as const;

export function useFilters() {
  const [params, setParams] = useSearchParams();
  const value = (key: string) => params.get(key) || '';

  function dateRange() {
    const year = new Date().getFullYear();
    switch (value('preset')) {
      case 'this-year':
        return { from: `${year}-01-01`, to: '' };
      case 'last-year':
        return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
      case 'last-90':
        return { from: isoDaysAgo(90), to: '' };
      case 'custom':
        return { from: value('from'), to: value('to') };
      default:
        return { from: '', to: '' };
    }
  }

  // The query string for the API, from the filters plus anything extra.
  function query(extra: Record<string, string | number | undefined> = {}) {
    const out = new URLSearchParams();
    const values: Record<string, string | number | undefined> = {
      ...dateRange(),
      store: value('store'),
      category: value('category'),
      zip: value('zip'),
      payment: value('payment'),
      q: value('q'),
      ...extra,
    };
    for (const [key, v] of Object.entries(values)) if (v !== '' && v !== undefined) out.set(key, String(v));
    return out.toString();
  }

  function set(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, v] of Object.entries(changes)) {
      if (v) next.set(key, v);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  const periodLabel = () => {
    const { from, to } = dateRange();
    return from || to ? `${from || 'start'}_to_${to || 'today'}` : 'all-time';
  };

  return { value, set, query, periodLabel, params };
}

export function FilterBar({ meta, show = KEYS as unknown as string[] }: { meta: Meta | null; show?: string[] }) {
  const { value, set } = useFilters();
  const [search, setSearch] = useState(value('q'));
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== value('q')) set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // Only the typed text should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const has = (key: string) => show.includes(key);
  return (
    <form className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.5fr)]" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
      <Field label="Period">
        <Select value={value('preset')} onChange={(e) => set({ preset: e.target.value })}>
          <option value="">All time</option>
          <option value="this-year">This year</option>
          <option value="last-year">Last year</option>
          <option value="last-90">Last 90 days</option>
          <option value="custom">Custom dates</option>
        </Select>
      </Field>
      {value('preset') === 'custom' && (
        <>
          <Field label="From">
            <Input type="date" value={value('from')} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={value('to')} onChange={(e) => set({ to: e.target.value })} />
          </Field>
        </>
      )}
      {has('store') && (
        <Field label="Store">
          <Select value={value('store')} onChange={(e) => set({ store: e.target.value })}>
            <option value="">All stores</option>
            {meta?.stores.map((s) => (
              <option key={s.store} value={s.store}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {has('category') && (
        <Field label="Category">
          <Select value={value('category')} onChange={(e) => set({ category: e.target.value })}>
            <option value="">All categories</option>
            {meta?.categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {has('zip') && (
        <Field label="Delivery ZIP">
          <Select value={value('zip')} onChange={(e) => set({ zip: e.target.value })}>
            <option value="">All ZIPs</option>
            {meta?.zips.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
            <option value="none">No delivery ZIP</option>
          </Select>
        </Field>
      )}
      {has('payment') && (
        <Field label="Payment">
          <Select value={value('payment')} onChange={(e) => set({ payment: e.target.value })}>
            <option value="">All payment methods</option>
            {meta?.payments.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="none">Not recorded</option>
          </Select>
        </Field>
      )}
      {has('q') && (
        <Field label="Search" className="col-span-2 sm:col-span-3 xl:col-span-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
            <Input type="search" className="pl-8" placeholder="Item name or order number" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
      )}
    </form>
  );
}

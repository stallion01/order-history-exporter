// Filters live in the address bar, so a filtered view can be bookmarked or shared,
// and the back button undoes a change.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { isoDaysAgo } from './format';
import { useBusiness } from './business';
import { Field, Input, MultiSelect, Select } from './ui';

export interface Meta {
  stores: { store: string; name: string }[];
  payments: string[];
  zips: string[];
  // Businesses and properties that spending is assigned to.
  entities: { id: number; name: string; kind: 'business' | 'rental' | 'other'; activity: string; taxForm: string; invested: number | null; investedOn: string | null }[];
  // Each ZIP's place name (its city, or a name you gave it).
  places: { zip: string; city: string | null; name: string | null; label: string; orders: number }[];
  years: string[];
  categories: { name: string; scheduleC: string | null; scheduleE: string | null; form1065: string | null; form8825: string | null; expenseClass: 'opex' | 'cogs' }[];
}

const KEYS = ['preset', 'from', 'to', 'years', 'store', 'category', 'zip', 'payment', 'q'] as const;
// Filters that can hold several values, as repeated keys: ?store=ebay&store=amazon.
export const LIST_KEYS = ['years', 'store', 'category', 'zip', 'payment'];

// With no period in the address, reports cover this year. 'all' is All time.
const DEFAULT_PRESET = 'this-year';

export function useFilters() {
  const [params, setParams] = useSearchParams();
  const value = (key: string) => (key === 'preset' ? params.get(key) || DEFAULT_PRESET : params.get(key) || '');
  const values = (key: string) => params.getAll(key).filter(Boolean);

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
      case 'years':
        return { from: '', to: '', years: values('years') };
      default:
        return { from: '', to: '' };
    }
  }
  const range = (): { from: string; to: string; years?: string[] } => dateRange();
  const { business } = useBusiness();

  // The query string for the API, from the filters plus anything extra.
  function query(extra: Record<string, string | number | undefined> = {}) {
    const out = new URLSearchParams();
    const all: Record<string, string | number | string[] | undefined> = {
      ...range(),
      store: values('store'),
      category: values('category'),
      zip: values('zip'),
      payment: values('payment'),
      q: value('q'),
      entity: business ?? undefined,
      ...extra,
    };
    for (const [key, v] of Object.entries(all)) {
      for (const one of Array.isArray(v) ? v : [v]) if (one !== '' && one !== undefined) out.append(key, String(one));
    }
    return out.toString();
  }

  function set(changes: Record<string, string | string[]>) {
    const next = new URLSearchParams(params);
    for (const [key, v] of Object.entries(changes)) {
      next.delete(key);
      for (const one of Array.isArray(v) ? v : [v]) if (one) next.append(key, one);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  const periodLabel = () => {
    const { from, to, years } = range();
    if (years?.length) return `years_${[...years].sort().join('_')}`;
    return from || to ? `${from || 'start'}_to_${to || 'today'}` : 'all-time';
  };

  return { value, values, set, query, range, periodLabel, params };
}

// The Period box (and its Years list), for pages with their own other filters.
export function PeriodFilter({ years }: { years: string[] }) {
  const { value, values, set } = useFilters();
  return (
    <>
      <Field label="Period">
        <Select value={value('preset')} onChange={(e) => set({ preset: e.target.value })}>
          <option value="all">All time</option>
          <option value="this-year">This year</option>
          <option value="last-year">Last year</option>
          <option value="last-90">Last 90 days</option>
          <option value="years">Pick years</option>
          <option value="custom">Custom dates</option>
        </Select>
      </Field>
      {value('preset') === 'years' && <MultiSelect label="Years" allLabel="All years" options={years.map((y) => [y, y])} selected={values('years')} onChange={(next) => set({ years: next })} />}
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
    </>
  );
}

// "North Andover, MA (01845)", or just the ZIP when no place is known.
export const placeOptions = (meta: Meta | null): [string, string][] =>
  (meta?.places || []).map((p) => [p.zip, p.label === p.zip ? p.zip : `${p.label} (${p.zip})`]);

export function FilterBar({ meta, show = KEYS as unknown as string[] }: { meta: Meta | null; show?: string[] }) {
  const { value, values, set } = useFilters();
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
          <option value="all">All time</option>
          <option value="this-year">This year</option>
          <option value="last-year">Last year</option>
          <option value="last-90">Last 90 days</option>
          <option value="years">Pick years</option>
          <option value="custom">Custom dates</option>
        </Select>
      </Field>
      {value('preset') === 'years' && (
        <MultiSelect label="Years" allLabel="All years" options={(meta?.years || []).map((y) => [y, y])} selected={values('years')} onChange={(next) => set({ years: next })} />
      )}
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
        <MultiSelect label="Store" allLabel="All stores" options={(meta?.stores || []).map((st) => [st.store, st.name])} selected={values('store')} onChange={(next) => set({ store: next })} />
      )}
      {has('category') && (
        <MultiSelect label="Category" allLabel="All categories" options={(meta?.categories || []).map((c) => [c.name, c.name])} selected={values('category')} onChange={(next) => set({ category: next })} />
      )}
      {has('zip') && (
        <MultiSelect
          label="Delivered to"
          allLabel="All places"
          options={[...placeOptions(meta), ['none', 'No delivery address']]}
          selected={values('zip')}
          onChange={(next) => set({ zip: next })}
        />
      )}
      {has('payment') && (
        <MultiSelect
          label="Payment"
          allLabel="All payment methods"
          options={[...(meta?.payments || []).map((p): [string, string] => [p, p]), ['none', 'Not recorded']]}
          selected={values('payment')}
          onChange={(next) => set({ payment: next })}
        />
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

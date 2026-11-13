// Every bank and card transaction, with filters, inline edits and exports.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Search, Upload, X } from 'lucide-react';
import { download, useApi } from '../api';
import { BulkBar, TxRow, txGrid } from '../bank';
import { when } from '../bank';
import type { Account, Transaction } from '../bank';
import { PeriodFilter, useFilters } from '../filters';
import type { Meta } from '../filters';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, MultiSelect, PageHeader, Pager, Select, Stat } from '../ui';

const PAGE = 50;

// The API query for the bank filters in the address bar.
export function useBankQuery() {
  const filters = useFilters();
  const query = (extra: Record<string, string | number> = {}) => {
    const out = new URLSearchParams();
    const { from, to, years } = filters.range();
    if (from) out.set('from', from);
    if (to) out.set('to', to);
    for (const y of years || []) out.append('years', y);
    for (const key of ['account', 'category', 'entity']) for (const v of filters.values(key)) out.append(key, v);
    for (const key of ['status', 'kind', 'direction', 'source', 'q', 'import', 'outcome', 'unmatched']) if (filters.value(key)) out.set(key, filters.value(key));
    for (const [key, v] of Object.entries(extra)) out.set(key, String(v));
    return out.toString();
  };
  return { ...filters, bankQuery: query };
}

// Income sources the dashboard chart links to.
const SOURCE_LABELS: Record<string, string> = { airbnb: 'Airbnb income', vrbo: 'Vrbo income', booking: 'Booking.com income', lease: 'lease rent', other: 'other income' };

export function Transactions({ meta }: { meta: Meta | null }) {
  const filters = useBankQuery();
  const sort = filters.value('sort') || 'date';
  const dir = filters.value('dir') || 'desc';
  const offset = Number(filters.value('page')) || 0;
  const list = useApi<{ total: number; moneyOut: number; moneyIn: number; transactions: Transaction[] }>(`/api/bank/transactions?${filters.bankQuery({ sort, dir, limit: PAGE, offset })}`);
  const accounts = useApi<{ accounts: Account[] }>('/api/bank/accounts');
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState(filters.value('q'));
  const [error, setError] = useState('');
  const categories = meta?.categories.map((c) => c.name) || [];
  const entities = meta?.entities || [];
  const years = [...new Set((accounts.data?.accounts || []).flatMap((a) => (a.firstDate && a.lastDate ? range(+a.firstDate.slice(0, 4), +a.lastDate.slice(0, 4)) : [])))].sort().reverse();

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.value('q')) filters.set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => setSelected([]), [list.data]);

  const accountIds = filters.values('account');
  const exportCsv = () => download(`/api/bank/export.csv?${filters.bankQuery()}`, `transactions_${filters.periodLabel()}.csv`).catch((e) => setError(e.message));
  const exportOfx = () => {
    const account = accounts.data?.accounts.find((a) => String(a.id) === accountIds[0]);
    download(`/api/bank/export.ofx?${filters.bankQuery({ kind: 'all' })}`, `${(account?.name || 'account').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}_${filters.periodLabel()}.ofx`).catch((e) => setError(e.message));
  };
  const data = list.data;

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Spending and income from your bank and card accounts."
        actions={
          <>
            <Link to="/import" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
              <Upload className="size-4" aria-hidden />
              Import a file
            </Link>
            <Button onClick={exportCsv} disabled={!data?.total}>
              <Download className="size-4" aria-hidden />
              CSV
            </Button>
            <Button onClick={exportOfx} disabled={!data?.total || accountIds.length !== 1} title={accountIds.length !== 1 ? 'Pick one account to export it as OFX' : undefined}>
              <Download className="size-4" aria-hidden />
              OFX
            </Button>
          </>
        }
      />

      <form className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <PeriodFilter years={years} />
        <MultiSelect label="Account" allLabel="All accounts" options={(accounts.data?.accounts || []).map((a) => [String(a.id), a.name])} selected={accountIds} onChange={(next) => filters.set({ account: next })} />
        <MultiSelect label="Category" allLabel="All categories" options={[...categories.map((c): [string, string] => [c, c]), ['none', 'No category']]} selected={filters.values('category')} onChange={(next) => filters.set({ category: next })} />
        <Field label="Business or personal">
          <Select value={filters.value('status')} onChange={(e) => filters.set({ status: e.target.value })}>
            <option value="">Either</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="none">Not decided</option>
          </Select>
        </Field>
        {entities.length > 0 && (
          <MultiSelect
            label="Business or property"
            allLabel="All"
            options={[...entities.map((e): [string, string] => [String(e.id), e.name]), ['none', 'Not assigned']]}
            selected={filters.values('entity')}
            onChange={(next) => filters.set({ entity: next })}
          />
        )}
        <Field label="Store orders">
          <Select value={filters.value('unmatched')} onChange={(e) => filters.set({ unmatched: e.target.value })}>
            <option value="">All transactions</option>
            <option value="1">Store charges without an order</option>
          </Select>
        </Field>
        <Field label="Type">
          <Select
            value={filters.value('direction') && !filters.value('kind') ? (filters.value('direction') === 'out' ? 'spending' : 'income') : filters.value('kind') || 'normal'}
            onChange={(e) => {
              const v = e.target.value;
              // Spending and Income are the usual transactions, split by money out or in.
              if (v === 'spending' || v === 'income') filters.set({ kind: '', direction: v === 'spending' ? 'out' : 'in', source: '' });
              else filters.set({ kind: v === 'normal' ? '' : v, direction: '', source: '' });
            }}
          >
            <option value="normal">Spending and income</option>
            <option value="spending">Spending only</option>
            <option value="income">Income only</option>
            <option value="transfer">Transfers</option>
            <option value="ignored">Ignored</option>
            <option value="all">Everything</option>
          </Select>
        </Field>
        <Field label="Search" className="col-span-2 sm:col-span-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
            <Input type="search" className="pl-8" placeholder="Payee, description or note" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
      </form>

      {SOURCE_LABELS[filters.value('source')] && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">
            Showing {SOURCE_LABELS[filters.value('source')]} only
            <button type="button" onClick={() => filters.set({ source: '' })} className="text-slate-500 hover:text-slate-900 dark:hover:text-white" aria-label="Show all income again">
              <X className="size-4" aria-hidden />
            </button>
          </span>
        </div>
      )}
      {filters.value('import') && <ImportFilter id={filters.value('import')} outcome={filters.value('outcome')} onChange={(changes) => filters.set(changes)} />}
      {(list.error || error) && <Banner>{list.error?.message || error}</Banner>}
      {accounts.data && !accounts.data.accounts.length && (
        <Banner tone="info">
          No bank or card accounts yet. <Link to="/accounts" className="font-medium underline">Connect SimpleFIN</Link> or <Link to="/import" className="font-medium underline">import a statement file</Link>.
        </Banner>
      )}

      {data && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Money out" value={money(data.moneyOut)} />
          <Stat label="Money in" value={money(data.moneyIn)} />
          <Stat label="Transactions" value={whole(data.total)} />
        </div>
      )}

      <Card title={data ? plural(data.total, 'transaction') : 'Transactions'} padded={false}>
        <BulkBar ids={selected} categories={categories} entities={entities} onDone={list.reload} />
        {!data && list.loading && <Loading />}
        {data && !data.transactions.length && <Empty>No transactions match these filters.</Empty>}
        {data && data.transactions.length > 0 && (
          <>
            <div className={`hidden ${txGrid(entities.length > 0)} gap-x-3 border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-600 md:grid dark:border-slate-800 dark:text-slate-400`}>
              <input
                type="checkbox"
                aria-label="Select all on this page"
                className="size-4 accent-emerald-700"
                checked={selected.length === data.transactions.length}
                onChange={(e) => setSelected(e.target.checked ? data.transactions.map((t) => t.id) : [])}
              />
              <SortButton label="Date" column="date" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              <SortButton label="Payee" column="payee" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              <SortButton label="Category" column="category" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              <span>Business or personal</span>
              {entities.length > 0 && <span>Business or property</span>}
              <span>Type</span>
              <span className="text-right">
                <SortButton label="Amount" column="amount" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              </span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.transactions.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  categories={categories}
                  entities={entities}
                  selected={selected.includes(tx.id)}
                  onSelect={(checked) => setSelected((s) => (checked ? [...s, tx.id] : s.filter((id) => id !== tx.id)))}
                  onChanged={list.reload}
                />
              ))}
            </ul>
          </>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={(next) => filters.set({ page: String(next) })} />}
      </Card>
    </>
  );
}

// Shown while the list is limited to one import's transactions.
function ImportFilter({ id, outcome, onChange }: { id: string; outcome: string; onChange: (changes: Record<string, string>) => void }) {
  const { data } = useApi<{ fileName: string | null; source: string; at: string; account: string | null; added: number; merged: number; skipped: number }>(`/api/bank/imports/${encodeURIComponent(id)}`);
  const tabs: [string, string, number | undefined][] = [
    ['', 'All', data ? data.added + data.merged + data.skipped : undefined],
    ['added', 'New', data?.added],
    ['merged', 'Matched', data?.merged],
    ['skipped', 'Already there', data?.skipped],
  ];
  return (
    <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Showing only transactions from <strong>{data ? data.fileName || 'a SimpleFIN update' : 'one import'}</strong>
          {data ? ` into ${data.account || 'a removed account'}, ${when(data.at)}` : ''}.
        </span>
        <button type="button" className="font-medium text-emerald-800 underline dark:text-emerald-300" onClick={() => onChange({ import: '', outcome: '' })}>
          Show all transactions
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Which of this import's transactions">
        {tabs.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            aria-pressed={outcome === value}
            onClick={() => onChange({ outcome: value })}
            className={
              outcome === value
                ? 'rounded-full bg-emerald-700 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-100'
            }
          >
            {label}
            {count !== undefined ? ` (${whole(count)})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function range(a: number, b: number) {
  const out: string[] = [];
  for (let y = a; y <= b; y++) out.push(String(y));
  return out;
}

function SortButton({ label, column, sort, dir, onSort }: { label: string; column: string; sort: string; dir: string; onSort: (column: string, dir: string) => void }) {
  const active = sort === column;
  return (
    <button
      type="button"
      className={active ? 'text-left text-slate-900 dark:text-white' : 'text-left hover:text-slate-900 dark:hover:text-white'}
      onClick={() => onSort(column, active ? (dir === 'asc' ? 'desc' : 'asc') : column === 'date' || column === 'amount' ? 'desc' : 'asc')}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

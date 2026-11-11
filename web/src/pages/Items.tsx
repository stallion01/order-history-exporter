import { useState } from 'react';
import { Download } from 'lucide-react';
import { download, post, useApi } from '../api';
import { FilterBar, useFilters } from '../filters';
import type { Meta } from '../filters';
import { money, plural } from '../format';
import { Banner, Button, Card, Confirm, Empty, Field, Loading, PageHeader, Pager, Select, SortHeader, TD, TR } from '../ui';

const PAGE = 50;
const STATUS_LABELS: Record<string, string> = { unreviewed: 'Not reviewed', business: 'Business', personal: 'Personal' };
const SOURCE_NOTES: Record<string, string> = { rule: 'Guessed from the name', learned: 'Learned from your changes', store: 'Guessed from the store' };

export function Items({ meta, onMetaChange }: { meta: Meta | null; onMetaChange: () => void }) {
  const filters = useFilters();
  const sort = filters.value('sort') || 'date';
  const dir = filters.value('dir') || 'desc';
  const offset = Number(filters.value('page')) || 0;
  const status = filters.value('status');
  const path = `/api/items?${filters.query({ sort, dir, limit: PAGE, offset, status })}`;
  const { data, error, loading, reload } = useApi<any>(path);
  const [actionError, setActionError] = useState('');
  const [note, setNote] = useState('');
  const [bulk, setBulk] = useState<null | 'business' | 'personal'>(null);
  const [busy, setBusy] = useState(false);

  const onSort = (column: string) =>
    filters.set({ sort: column, dir: sort === column ? (dir === 'asc' ? 'desc' : 'asc') : column === 'date' || column === 'amount' ? 'desc' : 'asc' });

  async function act(fn: () => Promise<unknown>) {
    setActionError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
      reload();
    }
  }

  const setCategory = (item: any, category: string) => act(() => post('/api/items/category', { name: item.name, category }));
  const setStatus = (item: any, value: string) => act(() => post('/api/items/status', { status: value, items: [{ store: item.store, orderId: item.orderId, name: item.name }] }));

  async function markAll() {
    if (!bulk) return;
    setBusy(true);
    await act(async () => {
      const filterObject = Object.fromEntries(new URLSearchParams(filters.query({ status })));
      const { changed } = await post<{ changed: number }>('/api/items/status', { status: bulk, filters: filterObject });
      setNote(`${plural(changed, 'item')} marked ${bulk}.`);
      onMetaChange();
    });
    setBusy(false);
    setBulk(null);
  }

  const categorySelect = (item: any) => (
    <Select aria-label={`Category for ${item.name}`} value={item.category} onChange={(e) => setCategory(item, e.target.value)} className="min-w-40">
      {[...new Set([...(meta?.categories.map((c) => c.name) || []), item.category])].map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );

  const statusSelect = (item: any) => (
    <Select aria-label={`Business or personal for ${item.name}`} value={item.status} onChange={(e) => setStatus(item, e.target.value)} className="min-w-32">
      {Object.entries(STATUS_LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Select>
  );

  const amount = (item: any) => (typeof item.amount === 'number' ? `${item.estimated ? '≈ ' : ''}${money(item.amount)}` : '–');

  return (
    <>
      <PageHeader
        title="Items"
        description="Every purchased item. Change a category once and it applies to every item with that name, and teaches similar ones. Amounts include each item's share of tax and shipping."
        actions={
          <Button
            onClick={() => download(`/api/items.csv?${filters.query({ status, sort, dir })}`, `items_${filters.periodLabel()}.csv`).catch((e) => setActionError(e.message))}
            disabled={!data?.total}
          >
            <Download className="size-4" aria-hidden />
            Download CSV
          </Button>
        }
      />
      <FilterBar meta={meta} />
      {(error || actionError) && <Banner>{error?.message || actionError}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}

      <Card
        title={data ? `${plural(data.total, 'item')} · ${money(data.amount)}` : 'Items'}
        padded={false}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Status" className="w-36">
              <Select value={status} onChange={(e) => filters.set({ status: e.target.value })}>
                <option value="">Any</option>
                <option value="unreviewed">Not reviewed</option>
                <option value="business">Business</option>
                <option value="personal">Personal</option>
              </Select>
            </Field>
            <Button onClick={() => setBulk('business')} disabled={!data?.total}>
              Mark all as business
            </Button>
            <Button onClick={() => setBulk('personal')} disabled={!data?.total}>
              Mark all as personal
            </Button>
          </div>
        }
      >
        {!data && loading && <Loading />}
        {data && !data.items.length && <Empty>No items match these filters.</Empty>}
        {data && data.items.length > 0 && (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <SortHeader label="Date" column="date" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Store" column="store" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Item" column="item" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Category" column="category" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="ZIP" column="zip" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Payment" column="payment" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Amount" column="amount" sort={sort} dir={dir} onSort={onSort} align="right" />
                    <SortHeader label="Business or personal" column="status" sort={sort} dir={dir} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item: any, index: number) => (
                    <tr key={`${item.store}-${item.orderId}-${index}`} className={TR}>
                      <td className={`${TD} whitespace-nowrap`}>{item.date}</td>
                      <td className={`${TD} whitespace-nowrap`}>{item.storeName}</td>
                      <td className={TD}>{item.name}</td>
                      <td className={TD}>
                        {categorySelect(item)}
                        {SOURCE_NOTES[item.categorySource] && <div className="mt-1 text-xs text-slate-500">{SOURCE_NOTES[item.categorySource]}</div>}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>{item.deliveryZip}</td>
                      <td className={`${TD} whitespace-nowrap`}>{item.payment}</td>
                      <td className={`${TD} text-right whitespace-nowrap tabular-nums`} title={item.estimated ? 'Estimated: this order has no item prices yet.' : undefined}>
                        {amount(item)}
                      </td>
                      <td className={TD}>
                        {statusSelect(item)}
                        {item.statusSource === 'rule' && <div className="mt-1 text-xs text-slate-500">From a rule</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-slate-100 lg:hidden dark:divide-slate-800">
              {data.items.map((item: any, index: number) => (
                <li key={`${item.store}-${item.orderId}-${index}`} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{item.name}</span>
                    <span className="shrink-0 tabular-nums">{amount(item)}</span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {item.date} · {item.storeName}
                    {item.deliveryZip ? ` · ${item.deliveryZip}` : ''}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {categorySelect(item)}
                    {statusSelect(item)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={(next) => filters.set({ page: String(next) })} />}
      </Card>

      <Confirm
        open={bulk !== null}
        title={`Mark ${data ? plural(data.total, 'item') : 'items'} as ${bulk}?`}
        confirmLabel={`Mark as ${bulk}`}
        busy={busy}
        onCancel={() => setBulk(null)}
        onConfirm={markAll}
      >
        Every item matching the current filters will be marked {bulk}. Your tax groups use this. You can change any item back later.
      </Confirm>
    </>
  );
}

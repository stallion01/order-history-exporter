import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { download, useApi } from '../api';
import { FilterBar, useFilters } from '../filters';
import type { Meta } from '../filters';
import { StoreOrdersGuide } from '../storeguide';
import { money, whole } from '../format';
import { Banner, Button, Card, Empty, Loading, PageHeader, Pager, SortHeader, TD, TH, TR } from '../ui';

const PAGE = 50;

function OrderLink({ url, children }: { url: string | null; children: string }) {
  if (!url || !/^https:\/\//i.test(url)) return <span>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline dark:text-emerald-400">
      {children}
    </a>
  );
}

// The card or bank charges that paid for an order.
function Charges({ charges }: { charges?: { id: number; posted: string; amount: number; account: string }[] }) {
  if (!charges?.length) return <span className="text-slate-400">Not matched</span>;
  return (
    <span className="flex flex-col">
      {charges.map((c) => (
        <Link key={c.id} to={`/transactions?preset=custom&kind=all&from=${c.posted}&to=${c.posted}`} className="text-emerald-700 hover:underline dark:text-emerald-400">
          {money(c.amount)} on {c.posted} · {c.account}
        </Link>
      ))}
    </span>
  );
}

export function Orders({ meta }: { meta: Meta | null }) {
  const filters = useFilters();
  const sort = filters.value('sort') || 'date';
  const dir = filters.value('dir') || 'desc';
  const offset = Number(filters.value('page')) || 0;
  const { data, error, loading } = useApi<any>(`/api/orders?${filters.query({ sort, dir, limit: PAGE, offset })}`);
  const [downloadError, setDownloadError] = useState('');

  const onSort = (column: string) =>
    filters.set({ sort: column, dir: sort === column ? (dir === 'asc' ? 'desc' : 'asc') : column === 'date' || column === 'total' ? 'desc' : 'asc' });

  const save = (layout: string) =>
    download(`/api/export.csv?${filters.query({ layout, sort, dir })}`, `orders_${filters.periodLabel()}_${layout}.csv`).catch((e) => setDownloadError(e.message));

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order synced from your stores by the Chrome extension."
        actions={
          <>
            <Button onClick={() => save('items')} disabled={!data?.total}>
              <Download className="size-4" aria-hidden />
              CSV by item
            </Button>
            <Button onClick={() => save('orders')} disabled={!data?.total}>
              <Download className="size-4" aria-hidden />
              CSV by order
            </Button>
          </>
        }
      />
      <StoreOrdersGuide compact={Boolean(data?.total)} />
      <FilterBar meta={meta} />
      {(error || downloadError) && <Banner>{error?.message || downloadError}</Banner>}
      <Card title={data ? `${whole(data.total)} orders` : 'Orders'} padded={false}>
        {!data && loading && <Loading />}
        {data && !data.orders.length && <Empty>No orders match these filters.</Empty>}
        {data && data.orders.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <SortHeader label="Date" column="date" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Store" column="store" sort={sort} dir={dir} onSort={onSort} />
                    <th className={TH}>Order</th>
                    <th className={TH}>Items</th>
                    <SortHeader label="Delivery ZIP" column="zip" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Payment" column="payment" sort={sort} dir={dir} onSort={onSort} />
                    <th className={TH}>Card charge</th>
                    <SortHeader label="Total" column="total" sort={sort} dir={dir} onSort={onSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((order: any) => (
                    <tr key={`${order.store}-${order.orderId}`} className={TR}>
                      <td className={`${TD} whitespace-nowrap`}>{order.date}</td>
                      <td className={`${TD} whitespace-nowrap`}>{order.storeName || order.store}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <OrderLink url={order.url}>{order.orderId}</OrderLink>
                      </td>
                      <td className={TD}>{order.items.map((item: any) => item.name).join('; ')}</td>
                      <td className={`${TD} whitespace-nowrap`}>{order.deliveryZip}</td>
                      <td className={`${TD} whitespace-nowrap`}>{order.payment}</td>
                      <td className={`${TD} whitespace-nowrap text-xs`}>
                        <Charges charges={order.charges} />
                      </td>
                      <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>{money(order.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
              {data.orders.map((order: any) => (
                <li key={`${order.store}-${order.orderId}`} className="px-4 py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{order.storeName || order.store}</span>
                    <span className="tabular-nums">{money(order.total)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {order.date} · <OrderLink url={order.url}>{order.orderId}</OrderLink>
                    {order.deliveryZip ? ` · ${order.deliveryZip}` : ''}
                  </div>
                  <div className="mt-1 line-clamp-2 text-slate-700 dark:text-slate-300">{order.items.map((item: any) => item.name).join('; ')}</div>
                  {order.charges?.length > 0 && (
                    <div className="mt-1 text-xs">
                      <Charges charges={order.charges} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={(next) => filters.set({ page: String(next) })} />}
      </Card>
    </>
  );
}

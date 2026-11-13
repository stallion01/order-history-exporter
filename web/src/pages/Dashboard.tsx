import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../api';
import { MonthlyBars, MonthlyInOut, RankBars } from '../charts';
import type { InOutMonth, MonthPart, Row } from '../charts';
import { FilterBar, useFilters } from '../filters';
import type { Meta } from '../filters';
import { when } from '../bank';
import { useBusiness } from '../business';
import type { Account, SimplefinStatus } from '../bank';
import { money, whole } from '../format';
import { Banner, Card, Empty, Loading, PageHeader, Stat, TD, TH, TR } from '../ui';

export function Dashboard({ meta }: { meta: Meta | null }) {
  const { business } = useBusiness();
  const { query, params, range } = useFilters();
  const navigate = useNavigate();

  // A page link that keeps the dashboard's filters, with the clicked one replacing
  // whatever was ticked for that filter.
  const linkTo = (path: string, changes: Record<string, string | string[]>) => {
    const next = new URLSearchParams();
    for (const key of ['preset', 'from', 'to', 'years', 'store', 'category', 'zip', 'payment', 'q']) {
      const change = changes[key];
      const chosen = key in changes ? (Array.isArray(change) ? change : [change]) : params.getAll(key);
      for (const value of chosen) if (value) next.append(key, value);
    }
    return `${path}?${next}`;
  };
  const by = (path: string, key: string) => (row: Row) => linkTo(path, { [key]: row.keys ?? row.key ?? row.label });
  const openMonth = (row: Row) => {
    const [year, month] = row.label.split('-').map(Number);
    const last = new Date(year, month, 0).getDate();
    navigate(linkTo('/orders', { preset: 'custom', from: `${row.label}-01`, to: `${row.label}-${String(last).padStart(2, '0')}` }));
  };
  // Personal spending is left out of the dashboard.
  const report = useApi<any>(`/api/report?${query()}&status=notpersonal`);
  const status = useApi<any>('/api/status');
  const data = report.data;
  const totals = data?.totals;

  const caveats: string[] = [];
  if (totals?.withoutTotal) caveats.push(`${totals.withoutTotal} order(s) have no total yet, so they aren't in the money figures.`);
  if (totals?.estimatedItems) caveats.push(`${totals.estimatedItems} item(s) have no price yet, so their share of an order is estimated.`);
  if (totals?.undated) caveats.push(`${totals.undated} order(s) have no date and only appear when no period is set.`);

  return (
    <>
      <PageHeader title="Dashboard" description="Business spending across your bank and card accounts, and your synced stores. Anything marked Personal is left out." />
      <FilterBar meta={meta} />
      <BankSummary range={range()} />
      {report.error && <Banner>{report.error.message}</Banner>}
      {!data && report.loading && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total spent" value={money(totals.spend ?? 0)} />
            <Stat label="Orders" value={whole(totals.orders)} />
            <Stat label="Average order" value={money(totals.average)} />
            <Stat label="Tax paid" value={totals.tax === null ? '–' : money(totals.tax ?? 0)} />
          </div>
          {caveats.length > 0 && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{caveats.join(' ')}</p>}

          {business !== null && <p className="mt-5 text-xs text-slate-500 dark:text-slate-400">Store orders below are for all businesses; their charges above are this business's.</p>}
          <Card title="Store orders by month" className="mt-5">
            <MonthlyBars rows={data.byMonth} onSelect={openMonth} />
          </Card>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card title="By category">
              <RankBars rows={data.byCategory} empty="No items match these filters." linkFor={by('/items', 'category')} />
            </Card>
            <Card title="By store (online orders)">
              <RankBars rows={data.byStore} empty="No orders match these filters." linkFor={by('/orders', 'store')} />
            </Card>
            <Card title="By payment method">
              <RankBars rows={data.byPayment} empty="No orders match these filters." linkFor={by('/orders', 'payment')} />
            </Card>
            <Card
              title="By delivery city"
              actions={
                <Link to="/settings#places" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
                  Name places
                </Link>
              }
            >
              <RankBars rows={data.byCity} empty="No delivered orders match these filters." linkFor={by('/orders', 'zip')} />
            </Card>
          </div>

          <Card title="Most-bought items" className="mt-5" padded={false}>
            {data.topItems.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Item</th>
                      <th className={`${TH} text-right`}>Orders</th>
                      <th className={`${TH} text-right`}>Quantity</th>
                      <th className={TH}>Last bought</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topItems.map((item: any) => (
                      <tr key={item.label} className={TR}>
                        <td className={TD}>
                          <Link to={linkTo('/items', { q: item.label })} className="hover:underline">
                            {item.label}
                          </Link>
                        </td>
                        <td className={`${TD} text-right tabular-nums`}>{whole(item.orders)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{whole(item.quantity)}</td>
                        <td className={`${TD} whitespace-nowrap`}>{item.lastBought}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No items match these filters.</Empty>
            )}
          </Card>
        </>
      )}

      <Card title="Sync status" className="mt-5" padded={false} actions={<Link to="/settings" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">Connect the extension</Link>}>
        {status.data?.stores?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH}>Store</th>
                  <th className={`${TH} text-right`}>Orders</th>
                  <th className={TH}>Fully read</th>
                  <th className={`${TH} text-right`}>Details missing</th>
                  <th className={TH}>Last sync</th>
                </tr>
              </thead>
              <tbody>
                {status.data.stores.map((s: any) => (
                  <tr key={s.store} className={TR}>
                    <td className={`${TD} whitespace-nowrap`}>{s.name}</td>
                    <td className={`${TD} text-right tabular-nums`}>{whole(s.orders)}</td>
                    <td className={TD}>{s.coverage.length ? s.coverage.map((c: any) => `${c.from || 'Beginning'} to ${c.to}`).join('; ') : 'Not yet'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{whole(s.missingDetails)}</td>
                    <td className={`${TD} whitespace-nowrap`}>{s.lastRun.finished_at ? new Date(s.lastRun.finished_at).toLocaleString() : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing synced yet. Run the Chrome extension to fill in your orders.</Empty>
        )}
      </Card>
    </>
  );
}

// Bank and card totals for the chosen period, and what needs reviewing.
function BankSummary({ range }: { range: { from: string; to: string; years?: string[] } }) {
  const { business, current } = useBusiness();
  const accounts = useApi<{ accounts: Account[]; simplefin: SimplefinStatus | null; reviewCount: number }>('/api/bank/accounts');
  const period = new URLSearchParams();
  if (range.from) period.set('from', range.from);
  if (range.to) period.set('to', range.to);
  for (const y of range.years || []) period.append('years', y);
  period.set('status', 'notpersonal');
  if (business) period.set('entity', String(business));
  const totals = useApi<{ total: number; moneyOut: number; moneyIn: number }>(`/api/bank/transactions?${period}&limit=1`);
  const spending = useApi<{ byCategory: { key: string; label: string; spend: number }[]; byEntity: { key: string; label: string; spend: number }[]; byMonth: InOutMonth[]; byStore: { key: string; label: string; spend: number }[] }>(
    `/api/bank/spending?${period}`
  );
  const navigate = useNavigate();
  // A month's transactions, keeping the dashboard's other filters: all of them, its
  // spending, or its income from one source.
  const openMonth = (month: string, part?: MonthPart) => {
    const [year, m] = month.split('-').map(Number);
    const last = new Date(year, m, 0).getDate();
    const next = params();
    for (const key of ['preset', 'from', 'to', 'years']) next.delete(key);
    next.set('preset', 'custom');
    next.set('from', `${month}-01`);
    next.set('to', `${month}-${String(last).padStart(2, '0')}`);
    for (const key of ['direction', 'source', 'kind']) next.delete(key);
    if (part === 'spend') next.set('direction', 'out');
    else if (part) {
      next.set('direction', 'in');
      next.set('source', part);
    }
    navigate(`/transactions?${next}`);
  };
  const asRows = (rows: { key: string; label: string; spend: number }[] = []) => rows.map((r) => ({ label: r.label, key: r.key, spend: r.spend }));
  const txLink = (key: string, value: string) => `/transactions?${new URLSearchParams([...params(), [key, value]])}`;
  const link = 'text-sm text-emerald-700 hover:underline dark:text-emerald-400';
  if (!accounts.data) return null;
  if (!accounts.data.accounts.length) {
    return (
      <Card title="Bank and card accounts" className="mb-5">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Add your bank and card accounts to see all spending here, not only store orders.{' '}
          <Link to="/accounts" className={link}>
            Connect SimpleFIN
          </Link>{' '}
          or{' '}
          <Link to="/import" className={link}>
            import a statement file
          </Link>
          .
        </p>
      </Card>
    );
  }
  const sf = accounts.data.simplefin;
  return (
    <Card
      title={current ? `${current.name}: bank and card accounts` : 'Bank and card accounts'}
      className="mb-5"
      actions={
        <Link to={`/transactions?${new URLSearchParams(params())}`} className={link}>
          See transactions
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Money out" value={money(totals.data?.moneyOut ?? 0)} hint="Excludes transfers between your accounts" />
        <Stat label="Money in" value={money(totals.data?.moneyIn ?? 0)} />
        <Stat
          label="To review"
          value={
            <Link to="/review" className={accounts.data.reviewCount ? 'text-amber-700 hover:underline dark:text-amber-400' : 'hover:underline'}>
              {whole(accounts.data.reviewCount)}
            </Link>
          }
          hint="Need a category, or business or personal"
        />
        <Stat label="Accounts" value={whole(accounts.data.accounts.length)} hint={sf?.connected ? `SimpleFIN updated ${when(sf.lastSuccess)}` : 'From imported files'} />
      </div>
      <div className="mt-5">
        <h3 className="mb-2 text-sm font-semibold">Spending and income by month</h3>
        <MonthlyInOut rows={spending.data?.byMonth ?? []} onSelect={openMonth} />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Spending is net of refunds. Transfers between your accounts, including card payments, are in neither.</p>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Spending by category</h3>
          <RankBars rows={asRows(spending.data?.byCategory)} empty="No spending in this period." linkFor={(row) => txLink('category', row.key === 'Uncategorized' ? 'none' : row.key!)} />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Store charges matched to orders are split by their items.</p>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Spending by store or payee</h3>
          <RankBars
            rows={asRows(spending.data?.byStore)}
            empty="No spending in this period."
            linkFor={(row) => `/transactions?${new URLSearchParams([...params(), ['q', row.key!], ['direction', 'out']])}`}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Every store and payee on your bank and card accounts, in person or online, net of refunds.</p>
        </div>
        {(spending.data?.byEntity.length ?? 0) > 1 || spending.data?.byEntity[0]?.key !== 'none' ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold">By business or property</h3>
            <RankBars rows={asRows(spending.data?.byEntity)} empty="No spending in this period." linkFor={(row) => txLink('entity', row.key!)} />
          </div>
        ) : (
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <h3 className="mb-2 text-sm font-semibold">By business or property</h3>
            Add your businesses and rental properties under{' '}
            <Link to="/settings" className={link}>
              Settings
            </Link>{' '}
            to see spending for each.
          </div>
        )}
      </div>
      {sf?.errors.length ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          SimpleFIN reported a problem on its last check. <Link to="/accounts" className="underline">See Accounts</Link>.
        </p>
      ) : null}
    </Card>
  );

  function params() {
    const out = new URLSearchParams(window.location.search);
    for (const key of ['store', 'zip', 'payment', 'category', 'q']) out.delete(key);
    return out;
  }
}

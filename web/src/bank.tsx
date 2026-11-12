// Pieces shared by the Transactions, Review and Accounts pages.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, BedDouble, Paperclip, Search, ShoppingCart, Unlink } from 'lucide-react';
import { get, post } from './api';
import { money } from './format';
import { Button, Input, cx } from './ui';

export interface Account {
  id: number;
  name: string;
  institution: string | null;
  kind: 'checking' | 'savings' | 'credit' | 'other';
  owner: 'business' | 'personal' | 'mixed';
  last4: string | null;
  currency: string;
  simplefinId: string | null;
  balance: number | null;
  balanceDate: string | null;
  lastSyncedAt: string | null;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  sources: string[];
  entityId: number | null;
}

export interface Entity {
  id: number;
  name: string;
  kind: 'business' | 'rental' | 'other';
}

export interface Share {
  entityId: number;
  percent: number;
}

export interface Transaction {
  id: number;
  accountId: number;
  account: string;
  posted: string;
  amount: number;
  description: string;
  payee: string | null;
  memo: string | null;
  kind: 'normal' | 'transfer' | 'ignored';
  kindSource: string | null;
  transferId: number | null;
  transferAccount: string | null;
  category: string | null;
  categorySource: string | null;
  status: 'business' | 'personal' | null;
  statusSource: string | null;
  note: string | null;
  sources: string[];
  receiptId: number | null;
  entityId: number | null;
  entitySource: string | null;
  shares: Share[];
  orders: { store: string; orderId: string; amount: number }[];
  // Stays this deposit paid for, from Hospitable.
  stays: { id: string; guest: string | null; property: string | null; arrival: string; departure: string }[];
}

export interface SimplefinStatus {
  connected: boolean;
  lastSuccess: string | null;
  lastAttempt: string | null;
  errors: string[];
  syncing: boolean;
}

export const KIND_LABELS = { checking: 'Checking', savings: 'Savings', credit: 'Credit card', other: 'Other' };
export const OWNER_LABELS = { business: 'Business', personal: 'Personal', mixed: 'Mixed (decide each)' };
export const ENTITY_KIND_LABELS = { business: 'Business', rental: 'Rental property', other: 'Other' };
export const SOURCE_LABELS: Record<string, string> = { simplefin: 'SimpleFIN', ofx: 'OFX/QFX file', csv: 'CSV file', receipt: 'Receipt' };
const WHY: Record<string, string> = {
  user: 'your choice',
  rule: 'from a rule',
  order: 'from its store order',
  receipt: 'from its receipt',
  payee: 'guessed from the payee',
  account: 'from the account',
  place: 'from where it was delivered',
  auto: 'found automatically',
};
// Payees whose charges are store orders (kept in step with the server's list).
const STORE_PAYEES = new Set(['Amazon', 'eBay', 'PayPal', 'Walmart', "Sam's Club", 'Newegg', 'Home Depot']);

export const importLink = (id: number, outcome?: 'added' | 'merged' | 'skipped') => `/transactions?preset=all&kind=all&import=${id}${outcome ? `&outcome=${outcome}` : ''}`;

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function SourceBadges({ sources }: { sources: string[] }) {
  return (
    <>
      {sources.map((s) => (
        <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {SOURCE_LABELS[s] || s}
        </span>
      ))}
    </>
  );
}

export function Amount({ value, className }: { value: number; className?: string }) {
  return <span className={cx('tabular-nums whitespace-nowrap', value > 0 ? 'text-emerald-700 dark:text-emerald-400' : '', className)}>{value > 0 ? `+${money(value)}` : money(value)}</span>;
}

const SMALL_SELECT = 'min-h-8 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

// The columns of a transaction row on wide screens; an entity column when there are entities.
export const txGrid = (withEntity: boolean) =>
  withEntity ? 'md:grid-cols-[auto_5.5rem_minmax(0,1fr)_12rem_8.5rem_10rem_7.5rem_7.5rem]' : 'md:grid-cols-[auto_5.5rem_minmax(0,1fr)_13rem_9.5rem_8rem_7.5rem]';

export type TxChange = { category?: string | null; status?: string | null; kind?: string | null; entity?: number | null; shares?: Share[] | null; flipSign?: true };

export const shareText = (shares: Share[], entities: Entity[]) =>
  shares.map((s) => `${entities.find((e) => e.id === s.entityId)?.name ?? 'Removed'} ${Math.round(s.percent * 100) / 100}%`).join(' · ');

// One transaction, editable in place. After a change, offers to make it a rule.
export function TxRow({
  tx,
  categories,
  entities = [],
  selected,
  onSelect,
  onChanged,
}: {
  tx: Transaction;
  categories: string[];
  entities?: Entity[];
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offer, setOffer] = useState<TxChange | null>(null);
  const [panel, setPanel] = useState<'orders' | 'share' | null>(null);
  const label = tx.payee || tx.description;
  const isStoreCharge = STORE_PAYEES.has(tx.payee || '') && tx.amount < 0;

  async function change(changes: TxChange, rule?: string) {
    setBusy(true);
    setError('');
    try {
      await post('/api/bank/transactions/update', { ids: [tx.id], ...changes, ...(rule ? { rule: { pattern: rule } } : {}) });
      const backToAuto = Object.values(changes).some((v) => v === null);
      setOffer(rule || backToAuto ? null : changes);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const entityValue = tx.shares.length ? 'split' : tx.entityId ? String(tx.entityId) : '';
  return (
    <li className={cx('px-4 py-3 text-sm', tx.kind !== 'normal' && 'bg-slate-50/70 dark:bg-slate-900/60')}>
      <div className={cx('grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-2 md:items-start', txGrid(entities.length > 0))}>
        <input
          type="checkbox"
          aria-label={`Select ${label} on ${tx.posted}`}
          className="mt-1 size-4 accent-emerald-700"
          checked={Boolean(selected)}
          onChange={(e) => onSelect?.(e.target.checked)}
          disabled={!onSelect}
        />
        <div className="hidden pt-1 whitespace-nowrap text-slate-600 md:block dark:text-slate-400">{tx.posted}</div>
        <div className="min-w-0">
          <div className="truncate font-medium" title={tx.description}>
            {label}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="md:hidden">{tx.posted} ·</span>
            <span>{tx.account}</span>
            {tx.payee && tx.payee !== tx.description && <span className="truncate">· {tx.description}</span>}
            {tx.kind === 'transfer' && <span>· Transfer{tx.transferAccount ? ` with ${tx.transferAccount}` : ''}</span>}
            {tx.receiptId && (
              <Link to={`/receipts/${tx.receiptId}`} className="inline-flex items-center gap-0.5 text-emerald-700 hover:underline dark:text-emerald-400">
                <Paperclip className="size-3" aria-hidden />
                Receipt
              </Link>
            )}
            {tx.stays.length > 0 && (
              <Link
                to={tx.stays.length === 1 ? `/stays/${tx.stays[0].id}` : `/stays?deposit=${tx.id}`}
                className="inline-flex items-center gap-0.5 text-emerald-700 hover:underline dark:text-emerald-400"
                title={tx.stays.map((s) => `${s.guest || 'Guest'}, ${s.property || ''} ${s.arrival} to ${s.departure}`).join('; ')}
              >
                <BedDouble className="size-3" aria-hidden />
                {tx.stays.length === 1 ? `Stay: ${tx.stays[0].guest || 'guest'}` : `${tx.stays.length} stays`}
              </Link>
            )}
            {(tx.orders.length > 0 || isStoreCharge) && (
              <button
                type="button"
                aria-expanded={panel === 'orders'}
                onClick={() => setPanel(panel === 'orders' ? null : 'orders')}
                className={cx('inline-flex items-center gap-0.5 hover:underline', tx.orders.length ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}
              >
                <ShoppingCart className="size-3" aria-hidden />
                {tx.orders.length ? (tx.orders.length === 1 ? 'Order ' + tx.orders[0].orderId : `${tx.orders.length} orders`) : 'Find its order'}
              </button>
            )}
            {tx.shares.length > 0 && <span>· Shared: {shareText(tx.shares, entities)}</span>}
            <SourceBadges sources={tx.sources} />
          </div>
        </div>
        <Amount value={tx.amount} className="text-right font-medium md:order-last md:pt-1" />
        <div className={cx('col-span-3 grid gap-2 md:contents', entities.length ? 'grid-cols-2' : 'grid-cols-3')}>
          <label className="min-w-0">
            <span className="sr-only">Category</span>
            <select
              className={SMALL_SELECT}
              value={tx.category || ''}
              disabled={busy || tx.kind !== 'normal'}
              onChange={(e) => change({ category: e.target.value || null })}
              title={tx.categorySource ? `Category ${WHY[tx.categorySource] || ''}` : undefined}
            >
              <option value="">{tx.category ? 'Back to automatic' : 'No category'}</option>
              {[...new Set([...categories, ...(tx.category ? [tx.category] : [])])].map((c) => (
                <option key={c} value={c}>
                  {c}
                  {c === tx.category && tx.categorySource && tx.categorySource !== 'user' ? ` (${WHY[tx.categorySource]})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Business or personal</span>
            <select
              className={cx(SMALL_SELECT, !tx.status && tx.kind === 'normal' && 'border-amber-400 dark:border-amber-600')}
              value={tx.status || ''}
              disabled={busy || tx.kind !== 'normal'}
              onChange={(e) => change({ status: e.target.value || null })}
              title={tx.statusSource ? WHY[tx.statusSource] : undefined}
            >
              <option value="">{tx.status ? 'Back to automatic' : 'Not decided'}</option>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </label>
          {entities.length > 0 && (
            <label className="min-w-0">
              <span className="sr-only">Business or property</span>
              <select
                className={SMALL_SELECT}
                value={entityValue}
                disabled={busy || tx.kind !== 'normal'}
                title={tx.entitySource ? WHY[tx.entitySource] : undefined}
                onChange={(e) => {
                  if (e.target.value === 'split') setPanel('share');
                  else change(e.target.value === 'auto' ? { entity: null } : { entity: Number(e.target.value) });
                }}
              >
                {!entityValue && <option value="">No business or property</option>}
                {entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                    {String(en.id) === entityValue && tx.entitySource && tx.entitySource !== 'user' ? ` (${WHY[tx.entitySource]})` : ''}
                  </option>
                ))}
                <option value="split">{tx.shares.length ? 'Shared (change…)' : 'Share between…'}</option>
                {tx.entitySource === 'user' && <option value="auto">Back to automatic</option>}
              </select>
            </label>
          )}
          <label className="min-w-0">
            <span className="sr-only">Type</span>
            <select className={SMALL_SELECT} value={tx.kind} disabled={busy} onChange={(e) => change({ kind: e.target.value === 'auto' ? null : e.target.value })}>
              <option value="normal">{tx.amount < 0 ? 'Spending' : 'Income'}</option>
              <option value="transfer">Transfer</option>
              <option value="ignored">Ignore</option>
              {tx.kindSource === 'user' && <option value="auto">Back to automatic</option>}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
      {panel === 'orders' && <OrdersPanel tx={tx} onChanged={onChanged} />}
      {panel === 'share' && (
        <ShareEditor
          entities={entities}
          initial={tx.shares}
          busy={busy}
          onCancel={() => setPanel(null)}
          onSave={async (shares) => {
            await change({ shares });
            setPanel(null);
          }}
        />
      )}
      {offer && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          <span>Do the same for every transaction from “{label}”, now and later?</span>
          <Button className="min-h-7 px-2 py-0.5 text-xs" busy={busy} onClick={() => change(offer, label)}>
            Make it a rule
          </Button>
          <button type="button" className="underline" onClick={() => setOffer(null)}>
            No thanks
          </button>
        </div>
      )}
    </li>
  );
}

interface OrderSuggestion {
  store: string;
  storeName: string;
  orderId: string;
  date: string | null;
  total: number | null;
  items: string | null;
  paidElsewhere: number;
  linked: boolean;
  exact: boolean;
}

// The store orders a charge paid for, how it splits by item, and others it might be.
function OrdersPanel({ tx, onChanged }: { tx: Transaction; onChanged: () => void }) {
  const [data, setData] = useState<{ suggestions: OrderSuggestion[]; split: { category: string; status: string | null; amount: number }[] } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (search = '') => {
    try {
      setData(await get(`/api/bank/transactions/${tx.id}/orders${search ? `?q=${encodeURIComponent(search)}` : ''}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.id]);

  async function act(path: 'link' | 'unlink', o: OrderSuggestion) {
    setBusy(true);
    setError('');
    try {
      setData(await post(`/api/bank/transactions/${tx.id}/orders/${path}`, { store: o.store, orderId: o.orderId }));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="mt-2 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-700">
      {error && <p className="mb-2 text-red-700 dark:text-red-400">{error}</p>}
      {!data && <p className="text-slate-500">Loading…</p>}
      {data && data.split.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 font-medium text-slate-700 dark:text-slate-200">Split by the order's items</div>
          <ul className="space-y-0.5">
            {data.split.map((line, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {line.category}
                  {line.status ? <span className="text-slate-500"> · {line.status === 'business' ? 'Business' : 'Personal'}</span> : null}
                </span>
                <span className="tabular-nums">{money(line.amount)}</span>
              </li>
            ))}
          </ul>
          {tx.categorySource === 'user' && <p className="mt-1 text-amber-700 dark:text-amber-400">You chose one category for the whole charge, so reports use that instead.</p>}
        </div>
      )}
      {data && (
        <>
          <div className="mb-1 font-medium text-slate-700 dark:text-slate-200">{data.suggestions.some((s) => s.linked) ? 'Orders' : 'Orders it might be'}</div>
          {!data.suggestions.length && <p className="text-slate-500">No orders around this date. Search below.</p>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.suggestions.slice(0, 8).map((o) => (
              <li key={`${o.store}-${o.orderId}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <Link to={`/orders?preset=all&q=${encodeURIComponent(o.orderId)}`} className="font-medium hover:underline">
                    {o.storeName} {o.orderId}
                  </Link>
                  <div className="truncate text-slate-500">
                    {o.date} · {money(o.total)}
                    {o.exact ? ' · same amount' : ''}
                    {o.paidElsewhere ? ` · ${money(o.paidElsewhere)} paid by other charges` : ''}
                    {o.items ? ` · ${o.items}` : ''}
                  </div>
                </div>
                {o.linked ? (
                  <Button className="min-h-7 px-2 py-0.5 text-xs" disabled={busy} onClick={() => act('unlink', o)}>
                    <Unlink className="size-3.5" aria-hidden />
                    Not this order
                  </Button>
                ) : (
                  <Button className="min-h-7 px-2 py-0.5 text-xs" disabled={busy} onClick={() => act('link', o)}>
                    This one
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              load(q.trim());
            }}
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-slate-400" aria-hidden />
              <Input className="min-h-8 py-1 pl-7 text-xs" placeholder="Search by order number or item" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Button type="submit" className="min-h-8 px-2 py-0.5 text-xs">
              Search
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

// Shares a transaction between businesses and properties, by percentage.
export function ShareEditor({ entities, initial, busy, onSave, onCancel }: { entities: Entity[]; initial: Share[]; busy?: boolean; onSave: (shares: Share[]) => void; onCancel: () => void }) {
  const start = Object.fromEntries(entities.map((e) => [e.id, String(initial.find((s) => s.entityId === e.id)?.percent ?? '')]));
  const [values, setValues] = useState<Record<number, string>>(start);
  const shares = entities.map((e) => ({ entityId: e.id, percent: Number(values[e.id]) || 0 })).filter((s) => s.percent > 0);
  const total = Math.round(shares.reduce((t, s) => t + s.percent, 0) * 100) / 100;
  const evenly = () => {
    const chosen = shares.length > 1 ? shares.map((s) => s.entityId) : entities.map((e) => e.id);
    const each = Math.round((100 / chosen.length) * 100) / 100;
    setValues(Object.fromEntries(entities.map((e) => [e.id, chosen.includes(e.id) ? String(each) : ''])));
  };
  return (
    <div className="mt-2 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-700">
      <div className="mb-2 font-medium text-slate-700 dark:text-slate-200">Share between businesses and properties</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {entities.map((e) => (
          <label key={e.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{e.name}</span>
            <span className="flex items-center gap-1">
              <Input className="min-h-8 w-20 py-1 text-right text-xs" inputMode="decimal" value={values[e.id] ?? ''} onChange={(ev) => setValues({ ...values, [e.id]: ev.target.value })} aria-label={`${e.name} percent`} />%
            </span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={cx('tabular-nums', Math.abs(total - 100) < 0.01 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>Total {total}%</span>
        <Button className="min-h-7 px-2 py-0.5 text-xs" onClick={evenly}>
          Split evenly
        </Button>
        <Button variant="primary" className="min-h-7 px-2 py-0.5 text-xs" busy={busy} disabled={shares.length < 2 || Math.abs(total - 100) >= 0.01} onClick={() => onSave(shares)}>
          Save
        </Button>
        <button type="button" className="underline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Sets a choice on every selected transaction.
export function BulkBar({ ids, categories, entities = [], onDone }: { ids: number[]; categories: string[]; entities?: Entity[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!ids.length) return null;
  async function apply(changes: TxChange) {
    setBusy(true);
    setError('');
    try {
      await post('/api/bank/transactions/update', { ids, ...changes });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  return (
    <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm md:top-0 dark:border-emerald-900 dark:bg-emerald-950">
      <span className="font-medium">{ids.length} selected</span>
      <select className={cx(SMALL_SELECT, 'w-auto')} disabled={busy} value="" onChange={(e) => e.target.value && apply({ category: e.target.value })} aria-label="Set category for selected">
        <option value="">Set category…</option>
        {categories.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {entities.length > 0 && (
        <select className={cx(SMALL_SELECT, 'w-auto')} disabled={busy} value="" onChange={(e) => e.target.value && apply({ entity: Number(e.target.value) })} aria-label="Set business or property for selected">
          <option value="">Set business or property…</option>
          {entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
            </option>
          ))}
        </select>
      )}
      <Button className="min-h-8" disabled={busy} onClick={() => apply({ status: 'business' })}>
        Business
      </Button>
      <Button className="min-h-8" disabled={busy} onClick={() => apply({ status: 'personal' })}>
        Personal
      </Button>
      <Button className="min-h-8" disabled={busy} onClick={() => apply({ kind: 'transfer' })}>
        Transfer
      </Button>
      <Button className="min-h-8" disabled={busy} onClick={() => apply({ kind: 'ignored' })}>
        Ignore
      </Button>
      <Button
        className="min-h-8"
        disabled={busy}
        title="For transactions imported the wrong way round: money in shown as spending, or the reverse"
        onClick={() =>
          window.confirm(`Swap money in and out for ${ids.length === 1 ? 'this transaction' : `these ${ids.length} transactions`}? Amounts with a minus lose it, and the rest gain one.`) &&
          apply({ flipSign: true })
        }
      >
        <ArrowLeftRight className="size-4" aria-hidden />
        Swap in/out
      </Button>
      {error && <span className="text-red-700 dark:text-red-400">{error}</span>}
    </div>
  );
}

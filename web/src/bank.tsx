// Pieces shared by the Transactions, Review and Accounts pages.
import { useState } from 'react';
import { post } from './api';
import { money } from './format';
import { Button, cx } from './ui';

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
export const SOURCE_LABELS: Record<string, string> = { simplefin: 'SimpleFIN', ofx: 'OFX/QFX file', csv: 'CSV file' };
const WHY: Record<string, string> = { user: 'your choice', rule: 'from a rule', payee: 'guessed from the payee', account: "from the account's owner", auto: 'found automatically' };

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

export type TxChange = { category?: string | null; status?: string | null; kind?: string | null };

// One transaction, editable in place. After a change, offers to make it a rule.
export function TxRow({
  tx,
  categories,
  selected,
  onSelect,
  onChanged,
}: {
  tx: Transaction;
  categories: string[];
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offer, setOffer] = useState<TxChange | null>(null);
  const label = tx.payee || tx.description;

  async function change(changes: TxChange, rule?: string) {
    setBusy(true);
    setError('');
    try {
      await post('/api/bank/transactions/update', { ids: [tx.id], ...changes, ...(rule ? { rule: { pattern: rule } } : {}) });
      setOffer(rule || changes.kind === null || changes.category === null || changes.status === null ? null : changes);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <li className={cx('px-4 py-3 text-sm', tx.kind !== 'normal' && 'bg-slate-50/70 dark:bg-slate-900/60')}>
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-2 md:grid-cols-[auto_5.5rem_minmax(0,1fr)_13rem_9.5rem_8rem_7.5rem] md:items-start">
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
            <SourceBadges sources={tx.sources} />
          </div>
        </div>
        <Amount value={tx.amount} className="text-right font-medium md:order-last md:pt-1" />
        <div className="col-span-3 grid grid-cols-3 gap-2 md:contents">
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

// Sets a choice on every selected transaction.
export function BulkBar({ ids, categories, onDone }: { ids: number[]; categories: string[]; onDone: () => void }) {
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
      {error && <span className="text-red-700 dark:text-red-400">{error}</span>}
    </div>
  );
}

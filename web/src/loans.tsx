// Loans whose balance you keep, because the bank feed doesn't update it: the balance
// comes down by each payment's principal, which you're asked for (from the bank's
// website) when a payment shows up.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Landmark, Undo2 } from 'lucide-react';
import { post, useApi } from './api';
import { money } from './format';
import { dayText } from './leases';
import { Button, Field, Input, cx } from './ui';

export interface LoanPayment {
  transactionId: number;
  date: string;
  amount: number;
  principal: number | null;
  interest: number | null;
  balanceAfter: number | null;
  skipped: boolean;
}
export interface Loan {
  accountId: number;
  name: string;
  entityId: number | null;
  balance: number | null;
  balanceDate: string | null;
  tracked: boolean;
  trackedFrom: string | null;
  payments: LoanPayment[];
}
export interface PendingPayment {
  transactionId: number;
  accountId: number;
  account: string;
  entityId: number | null;
  date: string;
  amount: number;
  description: string;
  balance: number;
}
export interface Loans {
  loans: Loan[];
  pending: PendingPayment[];
}

const number = (text: string) => {
  const n = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() && Number.isFinite(n) ? n : null;
};
const round = (n: number) => Math.round(n * 100) / 100;
const CHANGED = 'loans-changed';
// "Later" lasts until the next sign-in (this browser session).
const LATER = 'loan-payments-later';
const later = (): number[] => {
  try {
    return JSON.parse(sessionStorage.getItem(LATER) || '[]');
  } catch {
    return [];
  }
};

// Asks for the principal of each new loan payment, one at a time, oldest first.
export function LoanPaymentPrompt() {
  const data = useApi<Loans>('/api/loans');
  const [put, setPut] = useState<number[]>(later);
  const ref = useRef<HTMLDialogElement>(null);
  const due = (data.data?.pending ?? []).filter((p) => !put.includes(p.transactionId));
  const p = due[0];
  const [principal, setPrincipal] = useState('');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setPrincipal('');
    setBalance('');
    setError('');
  }, [p?.transactionId]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (p && !dialog.open) dialog.showModal();
    if (!p && dialog.open) dialog.close();
  }, [p]);
  if (!p) return null;

  // Either box can be filled in: the principal, or the balance the bank now shows.
  const fromPrincipal = number(principal);
  const fromBalance = number(balance);
  const part = fromPrincipal ?? (fromBalance !== null ? round(p.balance - fromBalance) : null);
  const after = part === null ? null : round(p.balance - part);
  const interest = part === null ? null : round(p.amount - part);
  const valid = part !== null && part > 0 && part <= p.amount;

  const putOff = () => {
    const next = [...put, p.transactionId];
    try {
      sessionStorage.setItem(LATER, JSON.stringify(next));
    } catch {
      // Private browsing: it asks again on the next page load.
    }
    setPut(next);
  };
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/loans/payments/${p.transactionId}/${path}`, body ?? {});
      data.reload();
      // Net worth on the page behind shows the new balance.
      window.dispatchEvent(new Event(CHANGED));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (valid) act('record', { principal: part });
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        putOff();
      }}
      className="m-auto w-[min(30rem,calc(100%-2rem))] rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
    >
      <form onSubmit={save}>
        <div className="p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Landmark className="size-5 text-emerald-700 dark:text-emerald-400" aria-hidden />
            A loan payment was made
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            <span className="font-medium text-slate-900 dark:text-white">{money(p.amount)}</span> was paid to {p.account} on {dayText(p.date)}. Look up on your bank&apos;s website how much of it went to
            principal, and enter that here or the new balance.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Principal paid">
              <Input
                inputMode="decimal"
                value={principal}
                placeholder="845.44"
                autoFocus
                onChange={(e) => {
                  setPrincipal(e.target.value);
                  setBalance('');
                }}
              />
            </Field>
            <Field label="Or the new balance">
              <Input
                inputMode="decimal"
                value={balance}
                placeholder={money(p.balance)}
                onChange={(e) => {
                  setBalance(e.target.value);
                  setPrincipal('');
                }}
              />
            </Field>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Balance before</dt>
              <dd className="font-medium tabular-nums">{money(p.balance)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Interest</dt>
              <dd className="font-medium tabular-nums">{interest === null ? '–' : money(interest)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">New balance</dt>
              <dd className="font-medium tabular-nums">{after === null ? '–' : money(after)}</dd>
            </div>
          </dl>
          {part !== null && !valid && <p className="mt-2 text-xs text-red-700 dark:text-red-400">The principal should be more than $0 and no more than the payment.</p>}
          {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            The interest is recorded as Mortgage Interest and the principal as a loan payment. The same payment out of checking is set aside so it isn&apos;t counted twice.
            {due.length > 1 ? ` ${due.length - 1} more after this one.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <button type="button" className="mr-auto text-xs text-slate-500 hover:underline" disabled={busy} onClick={() => act('skip')} title="The balance already includes this payment, or it isn't a loan payment">
            Already counted
          </button>
          <Button type="button" onClick={putOff}>
            Later
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!valid}>
            Save
          </Button>
        </div>
      </form>
    </dialog>
  );
}

// The business's loans under Net worth: the balance, and keeping it yourself.
export function LoanBalances({ entityId, onSaved }: { entityId: number | null; onSaved: () => void }) {
  const data = useApi<Loans>('/api/loans');
  const loans = (data.data?.loans ?? []).filter((l) => entityId === null || l.entityId === entityId);
  const changed = () => {
    data.reload();
    onSaved();
  };
  const latest = useRef(changed);
  latest.current = changed;
  useEffect(() => {
    const listen = () => latest.current();
    window.addEventListener(CHANGED, listen);
    return () => window.removeEventListener(CHANGED, listen);
  }, []);
  if (!loans.length) return null;
  return (
    <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      {loans.map((loan) => (
        <LoanRow key={loan.accountId} loan={loan} pending={(data.data?.pending ?? []).filter((p) => p.accountId === loan.accountId).length} onSaved={changed} />
      ))}
    </div>
  );
}

function LoanRow({ loan, pending, onSaved }: { loan: Loan; pending: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [balance, setBalance] = useState('');
  const [asOf, setAsOf] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState('');
  const open = () => {
    setBalance(loan.balance === null ? '' : String(loan.balance));
    setAsOf(new Date().toISOString().slice(0, 10));
    setError('');
    setEditing(true);
  };
  const call = async (path: string, body: unknown) => {
    setError('');
    try {
      await post(path, body);
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const n = number(balance);
    if (n === null) return setError('Enter the balance owed.');
    call(`/api/loans/${loan.accountId}`, { tracked: true, balance: n, asOf });
  };
  const recorded = loan.payments.filter((p) => !p.skipped);
  const latest = recorded[0];
  return (
    <div className="text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{loan.name}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {loan.tracked ? `${money(loan.balance)} owed as of ${dayText(loan.balanceDate)}, less each payment's principal` : `${money(loan.balance)} from the bank feed`}
            {pending > 0 && <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">· {pending === 1 ? '1 payment needs' : `${pending} payments need`} its principal</span>}
          </div>
        </div>
        {!editing && (
          <button type="button" onClick={open} className="shrink-0 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            {loan.tracked ? 'Correct the balance' : 'Keep the balance myself'}
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={save} className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Balance owed">
            <Input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} autoFocus />
          </Field>
          <Field label="As of" hint="Payments after this date will ask for their principal">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <div className="col-span-2 flex flex-wrap items-center gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {loan.tracked && (
              <button type="button" className="ml-auto text-xs text-slate-500 hover:underline" onClick={() => call(`/api/loans/${loan.accountId}`, { tracked: false })}>
                Use the bank feed&apos;s balance again
              </button>
            )}
          </div>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p>}
      {recorded.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-400">
          {(showAll ? recorded : recorded.slice(0, 3)).map((p) => (
            <li key={p.transactionId} className="flex flex-wrap items-center justify-between gap-x-3">
              <span>
                {dayText(p.date)}: {money(p.principal)} principal, {money(p.interest)} interest
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {money(p.balanceAfter)}
                {p === latest && (
                  <button type="button" title="Take this payment back to enter it again" aria-label="Undo this payment" className="text-slate-400 hover:text-slate-700 dark:hover:text-white" onClick={() => call(`/api/loans/payments/${p.transactionId}/undo`, {})}>
                    <Undo2 className="size-3.5" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
          {recorded.length > 3 && (
            <li>
              <button type="button" className={cx('text-emerald-700 hover:underline dark:text-emerald-400')} onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${recorded.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

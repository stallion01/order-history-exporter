// One stay: the guest, the dates, the money, and the deposit that paid for it.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Link2, Mail, MapPin, Phone, Unlink } from 'lucide-react';
import { post, useApi } from '../api';
import { money } from '../format';
import { dateRange, localTime, longDate, partyText } from '../stays';
import type { Conflict, DepositRow, StayDetail as Detail } from '../stays';
import { Banner, Button, Card, Empty, Loading, cx } from '../ui';
import { PlatformBadge } from './Stays';

// Opens the deposit among that day's transactions.
const depositLink = (d: DepositRow) => `/transactions?preset=custom&from=${d.posted}&to=${d.posted}`;

const PURPOSE_LABELS = { stay: 'For the stay:', security: 'Security deposit:', refund: 'Refund paid back:' };

function DepositLine({ deposit, action, footer }: { deposit: DepositRow & { exact?: boolean }; action?: ReactNode; footer?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0">
        <Link to={depositLink(deposit)} className="font-medium hover:underline">
          {deposit.payee}
        </Link>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {longDate(deposit.posted)} · {deposit.account}
          {deposit.exact ? ' · exact amount' : ''}
        </div>
        {footer && <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{footer}</div>}
      </div>
      <div className="flex items-center gap-3">
        <span className={cx('font-medium tabular-nums', deposit.amount < 0 ? 'text-slate-700 dark:text-slate-300' : 'text-emerald-700 dark:text-emerald-400')}>{money(deposit.amount)}</span>
        {action}
      </div>
    </li>
  );
}

function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-3 py-1.5 text-sm', strong && 'border-t border-slate-200 pt-2 font-semibold dark:border-slate-700')}>
      <span className={strong ? '' : 'text-slate-600 dark:text-slate-400'}>{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

export function StayDetail() {
  const { id } = useParams();
  const search = useLocation().search;
  const detail = useApi<Detail>(id ? `/api/stays/${encodeURIComponent(id)}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);

  useEffect(() => {
    setNote(detail.data?.stay.note || '');
  }, [detail.data?.stay.note]);

  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      await post(path, body);
      detail.reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function saveNote() {
    await run(`/api/stays/${encodeURIComponent(id || '')}`, { note: note.trim() || null });
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2000);
  }

  const back = (
    <Link to={`/stays${search}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:underline dark:text-slate-400">
      <ArrowLeft className="size-4" aria-hidden />
      Stays
    </Link>
  );
  if (detail.error) return (
    <>
      {back}
      <Banner>{detail.error.message}</Banner>
    </>
  );
  if (!detail.data) return <Loading />;
  const { stay: s, lines, payouts, deposits, suggestions, conflicts } = detail.data;
  const host = lines.filter((l) => l.side === 'host');
  const guest = lines.filter((l) => l.side === 'guest');
  const checkIn = localTime(s.checkIn);
  const checkOut = localTime(s.checkOut);
  const party = partyText(s);

  return (
    <>
      {back}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{s.guest || 'Guest'}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
          <PlatformBadge platform={s.platform} label={s.platformLabel} />
          <span>{s.property || 'Unknown property'}</span>
          <span>{dateRange(s.arrival, s.departure)}</span>
          {s.status !== 'accepted' && <span className="rounded bg-slate-200 px-1.5 text-xs font-medium capitalize dark:bg-slate-700">{s.status}</span>}
        </div>
      </div>
      {error && <Banner>{error}</Banner>}
      {conflicts.map((c) => (
        <ConflictCard key={c.deposit.id} conflict={c} stayId={s.id} busy={busy} onPick={(subjects) => run('/api/stays/conflicts/resolve', { transactionId: c.deposit.id, subjects })} />
      ))}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Guest">
          <div className="space-y-2 text-sm">
            {s.phone && (
              <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-2 text-emerald-700 hover:underline dark:text-emerald-400">
                <Phone className="size-4" aria-hidden />
                {s.phone}
              </a>
            )}
            {s.email && (
              <a href={`mailto:${s.email}`} className="flex items-center gap-2 text-emerald-700 hover:underline dark:text-emerald-400">
                <Mail className="size-4" aria-hidden />
                {s.email}
              </a>
            )}
            {s.location && (
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <MapPin className="size-4" aria-hidden />
                {s.location}
              </div>
            )}
            {!s.phone && !s.email && !s.location && <p className="text-slate-500 dark:text-slate-400">No contact details from Hospitable.</p>}
          </div>
          <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
            {party && <Row label="Party" value={party} />}
            {s.code && <Row label="Confirmation code" value={<span className="font-mono text-xs">{s.code}</span>} />}
            {s.bookedAt && <Row label="Booked" value={longDate(s.bookedAt)} />}
          </div>
        </Card>

        <Card title="Stay">
          <Row label="Property" value={s.property || '–'} />
          <Row label="Check-in" value={`${longDate(s.arrival)}${checkIn ? `, ${checkIn}` : ''}`} />
          <Row label="Check-out" value={`${longDate(s.departure)}${checkOut ? `, ${checkOut}` : ''}`} />
          <Row label="Nights" value={s.nights} />
          {s.accommodation !== null && s.nights > 0 && <Row label="Average night" value={money(s.accommodation / s.nights)} />}
        </Card>

        <Card title="Money">
          {host.length ? (
            host.map((l, i) => <Row key={i} label={l.label || l.category} value={money(l.amount)} strong={i === host.length - 1} />)
          ) : (
            <Row label="Payout" value={money(s.payout)} strong />
          )}
          {guest.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-slate-600 dark:text-slate-400">What the guest paid: {money(s.guestTotal)}</summary>
              <div className="mt-1">
                {guest.map((l, i) => (
                  <Row key={i} label={l.label || l.category} value={money(l.amount)} strong={i === guest.length - 1} />
                ))}
              </div>
            </details>
          )}
        </Card>

        <Card title="Deposit">
          {payouts.map((p) => (
            <div key={p.id} className="mb-4 last:mb-0">
              <p className="text-sm">
                Airbnb paid out <span className="font-medium">{money(p.amount)}</span> on {longDate(p.paidOn)}
                {p.bankAccount ? ` to the account ending ${p.bankAccount}` : ''}.
              </p>
              {p.lines.length > 1 && (
                <ul className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {p.lines.map((l, i) => (
                    <li key={i}>
                      {l.stayId && l.stayId !== s.id ? (
                        <Link to={`/stays/${l.stayId}`} className="hover:underline">
                          {l.guest || l.type}
                        </Link>
                      ) : (
                        <span className={l.stayId === s.id ? 'font-medium' : ''}>{l.stayId === s.id ? 'This stay' : l.guest || l.type}</span>
                      )}{' '}
                      {money(l.amount)}
                    </li>
                  ))}
                </ul>
              )}
              {p.deposit ? (
                <ul>
                  <DepositLine
                    deposit={p.deposit}
                    action={
                      <Button busy={busy} onClick={() => run(`/api/stays/payouts/${p.id}/unlink`)} title="Not this deposit">
                        <Unlink className="size-4" aria-hidden />
                        <span className="sr-only">Unlink</span>
                      </Button>
                    }
                  />
                </ul>
              ) : (
                <Suggestions list={p.suggestions} busy={busy} onLink={(txId) => run(`/api/stays/payouts/${p.id}/link`, { transactionId: txId })} />
              )}
            </div>
          ))}

          {!payouts.length && s.status !== 'accepted' && !deposits.length && <Empty>This stay was {s.status}.</Empty>}
          {!payouts.length && (s.status === 'accepted' || deposits.length > 0) && (
            <>
              <Row label="Expected" value={money(s.depositAmount ?? s.payout)} />
              {s.depositAmount !== null && s.payout !== null && Math.round(s.depositAmount * 100) !== Math.round(s.payout * 100) && (
                <p className="-mt-1 mb-1 text-xs text-slate-500 dark:text-slate-400">
                  {s.platformLabel} pays the full {money(s.depositAmount)} and bills its commission of {money(s.depositAmount - s.payout)} separately.
                </p>
              )}
              <Row label="Received" value={money(s.received)} />
              {detail.data.due > 0.005 && <Row label={s.payment === 'upcoming' ? 'Still to come' : 'Still due'} value={money(detail.data.due)} strong />}

              {deposits.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                  {deposits.map((d) => (
                    <DepositLine
                      key={`${d.id}-${d.purpose}`}
                      deposit={d}
                      action={
                        <Button busy={busy} onClick={() => run(`/api/stays/${encodeURIComponent(s.id)}/unlink`, { transactionId: d.id, purpose: d.purpose })} title="Unlink this part">
                          <Unlink className="size-4" aria-hidden />
                          <span className="sr-only">Unlink</span>
                        </Button>
                      }
                      footer={
                        <>
                          {PURPOSE_LABELS[d.purpose]} {money(d.share)}
                          {Math.abs(d.amount) - d.share > 0.005 ? ` of ${money(Math.abs(d.amount))}` : ''}
                          {d.balance > 0.005 && d.purpose !== 'refund' && (
                            <>
                              {' · '}
                              {money(d.balance)} left for other stays{' '}
                              <button
                                type="button"
                                className="font-medium text-emerald-700 underline dark:text-emerald-400"
                                disabled={busy}
                                onClick={() => run(`/api/stays/${encodeURIComponent(s.id)}/link`, { transactionId: d.id, purpose: 'security' })}
                              >
                                Hold the {money(d.balance)} as a security deposit
                              </button>
                            </>
                          )}
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
              {s.status === 'accepted' && detail.data.due > 0.005 && (
                <Suggestions list={suggestions} due={detail.data.due} busy={busy} onLink={(txId, amount) => run(`/api/stays/${encodeURIComponent(s.id)}/link`, { transactionId: txId, amount })} />
              )}

              {s.security > 0 && (
                <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <p className="text-sm font-medium">Security deposit</p>
                  <Row label="Held" value={money(s.security)} />
                  <Row label="Returned" value={money(s.refunded)} />
                  {s.security - s.refunded > 0.005 ? (
                    <>
                      <Row label="Still to return" value={money(s.security - s.refunded)} strong />
                      {detail.data.refundSuggestions.length ? (
                        <>
                          <p className="mt-2 text-xs font-medium text-slate-600 dark:text-slate-400">Is it one of these payments out?</p>
                          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                            {detail.data.refundSuggestions.map((r) => (
                              <DepositLine
                                key={r.id}
                                deposit={r}
                                action={
                                  <Button busy={busy} onClick={() => run(`/api/stays/${encodeURIComponent(s.id)}/link`, { transactionId: r.id, purpose: 'refund' })}>
                                    <Link2 className="size-4" aria-hidden />
                                    It's the refund
                                  </Button>
                                }
                              />
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">When the refund leaves your bank, it will be offered here to link.</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">Returned in full.</p>
                  )}
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Note" className="lg:col-span-2">
          <textarea
            className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything to remember about this stay"
            aria-label="Note"
          />
          <div className="mt-2 flex items-center gap-3">
            <Button busy={busy} disabled={note === (s.note || '')} onClick={saveNote}>
              Save note
            </Button>
            {noteSaved && <span className="text-sm text-emerald-700 dark:text-emerald-400">Saved</span>}
          </div>
        </Card>
      </div>
    </>
  );
}

function Suggestions({ list, due, busy, onLink }: { list: (DepositRow & { exact: boolean; balance?: number })[]; due?: number; busy: boolean; onLink: (txId: number, amount?: number) => void }) {
  if (!list.length) return <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No deposit in the bank looks like this one yet.</p>;
  return (
    <>
      <p className="mt-3 text-xs font-medium text-slate-600 dark:text-slate-400">Could be one of these:</p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {list.map((d) => (
          <Suggestion key={d.id} deposit={d} due={due} busy={busy} onLink={onLink} />
        ))}
      </ul>
    </>
  );
}

// One possible deposit, with how much of it to take: what's due, up to what's left of it.
function Suggestion({ deposit: d, due, busy, onLink }: { deposit: DepositRow & { exact: boolean; balance?: number }; due?: number; busy: boolean; onLink: (txId: number, amount?: number) => void }) {
  const left = d.balance ?? d.amount;
  const [amount, setAmount] = useState(() => (due !== undefined ? Math.min(due, left) : left).toFixed(2));
  const value = Number(amount);
  const ok = value > 0 && value <= left + 0.005;
  return (
    <DepositLine
      deposit={d}
      footer={left < d.amount - 0.005 ? `${money(left)} of it is still free` : undefined}
      action={
        <span className="flex items-center gap-2">
          {due !== undefined && (
            <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="sr-only">Amount for this stay</span>$
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                max={left}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-24 rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          )}
          <Button busy={busy} disabled={!ok} onClick={() => onLink(d.id, due !== undefined ? Math.round(value * 100) / 100 : undefined)}>
            <Link2 className="size-4" aria-hidden />
            Link
          </Button>
        </span>
      }
    />
  );
}

// A deposit that adds up more than one way: the user says which.
function ConflictCard({ conflict: c, stayId, busy, onPick }: { conflict: Conflict; stayId: string; busy: boolean; onPick: (subjects: string[]) => void }) {
  return (
    <Card title="Conflict: which stays did this deposit pay for?" className="mb-5 border-red-300 dark:border-red-900">
      <p className="mb-3 text-sm">
        The deposit of <span className="font-medium">{money(c.deposit.amount)}</span> on {longDate(c.deposit.posted)} ({c.deposit.account}) adds up in more than one way, so nothing was linked. Pick the
        one that matches your Airbnb payout report.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {c.options.map((o, n) => (
          <div key={n} className="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
            <ul className="mb-3 space-y-1">
              {o.items.map((i) => (
                <li key={i.subject} className="flex justify-between gap-3">
                  <span className={cx('min-w-0', i.stayIds.includes(stayId) && 'font-medium')}>
                    {i.kind === 'stay' ? (
                      <Link to={`/stays/${i.id}`} className="hover:underline">
                        {i.label}
                      </Link>
                    ) : (
                      i.label
                    )}
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {i.kind === 'payout' ? 'Paid out ' : 'Arrived '}
                      {longDate(i.date)}
                      {i.detail ? ` · ${i.detail}` : ''}
                    </span>
                  </span>
                  <span className="tabular-nums">{money(i.amount)}</span>
                </li>
              ))}
            </ul>
            <Button busy={busy} onClick={() => onPick(o.subjects)}>
              This is it
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

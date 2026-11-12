// One stay: the guest, the dates, the money, and the deposit that paid for it.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Link2, Mail, MapPin, Phone, Unlink } from 'lucide-react';
import { post, useApi } from '../api';
import { money, plural } from '../format';
import { dateRange, localTime, longDate, partyText } from '../stays';
import type { Conflict, DepositRow, StayDetail as Detail } from '../stays';
import { Banner, Button, Card, Empty, Loading, cx } from '../ui';
import { PlatformBadge } from './Stays';

// Opens the deposit among that day's transactions.
const depositLink = (d: DepositRow) => `/transactions?preset=custom&from=${d.posted}&to=${d.posted}`;

function DepositLine({ deposit, action }: { deposit: DepositRow & { exact?: boolean }; action?: ReactNode }) {
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
      </div>
      <div className="flex items-center gap-3">
        <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">{money(deposit.amount)}</span>
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
  const paidSoFar = deposits.reduce((n, d) => n + d.amount, 0);

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

          {!payouts.length && (
            <>
              {deposits.length > 0 && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {deposits.map((d) => (
                    <DepositLine
                      key={d.id}
                      deposit={d}
                      action={
                        <Button busy={busy} onClick={() => run(`/api/stays/${encodeURIComponent(s.id)}/unlink`, { transactionId: d.id })} title="Not this deposit">
                          <Unlink className="size-4" aria-hidden />
                          <span className="sr-only">Unlink</span>
                        </Button>
                      }
                    />
                  ))}
                </ul>
              )}
              {deposits.length > 1 && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Paid in {plural(deposits.length, 'part')}, {money(paidSoFar)} in all.</p>}
              {!deposits.length && s.status === 'accepted' && (
                <>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {s.payment === 'upcoming' ? 'The stay is still to come.' : 'No deposit is linked yet.'} Expected: <span className="font-medium">{money(s.depositAmount ?? s.payout)}</span>.
                  </p>
                  {s.depositAmount !== null && s.payout !== null && Math.round(s.depositAmount * 100) !== Math.round(s.payout * 100) && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {s.platformLabel} pays the full {money(s.depositAmount)} and bills its commission of {money(s.depositAmount - s.payout)} separately.
                    </p>
                  )}
                  <Suggestions list={suggestions} busy={busy} onLink={(txId) => run(`/api/stays/${encodeURIComponent(s.id)}/link`, { transactionId: txId })} />
                </>
              )}
              {!deposits.length && s.status !== 'accepted' && <Empty>This stay was {s.status}.</Empty>}
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

function Suggestions({ list, busy, onLink }: { list: (DepositRow & { exact: boolean })[]; busy: boolean; onLink: (txId: number) => void }) {
  if (!list.length) return <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No deposit in the bank looks like this one yet.</p>;
  return (
    <>
      <p className="mt-3 text-xs font-medium text-slate-600 dark:text-slate-400">Could be one of these:</p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {list.map((d) => (
          <DepositLine
            key={d.id}
            deposit={d}
            action={
              <Button busy={busy} onClick={() => onLink(d.id)}>
                <Link2 className="size-4" aria-hidden />
                Link
              </Button>
            }
          />
        ))}
      </ul>
    </>
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

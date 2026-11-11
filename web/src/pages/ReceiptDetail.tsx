// One receipt: the photo, what was read from it (editable), and its transaction.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Link2, RefreshCw, Trash2, Unlink, Wallet } from 'lucide-react';
import { post, useApi } from '../api';
import { Amount } from '../bank';
import type { Meta } from '../filters';
import { money } from '../format';
import { STATUS_LABELS } from '../receipts';
import type { Receipt, Suggestion } from '../receipts';
import { Banner, Button, Card, Confirm, Empty, Field, Input, Loading, Select, TD, TH, TR } from '../ui';

interface Form {
  vendor: string;
  date: string;
  total: string;
  tax: string;
  tip: string;
  cardLast4: string;
  category: string;
  note: string;
}

const toForm = (r: Receipt): Form => ({
  vendor: r.vendor || '',
  date: r.date || '',
  total: r.total === null ? '' : String(r.total),
  tax: r.tax === null ? '' : String(r.tax),
  tip: r.tip === null ? '' : String(r.tip),
  cardLast4: r.cardLast4 || '',
  category: r.category || '',
  note: r.note || '',
});
const number = (text: string) => (text.trim() === '' ? null : Number(text.replace(/[$,\s]/g, '')));

export function ReceiptDetail({ meta }: { meta: Meta | null }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<{ receipt: Receipt; suggestions: Suggestion[] }>(`/api/receipts/${encodeURIComponent(id || '')}`);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const receipt = data?.receipt;
  const reading = receipt && (receipt.status === 'reading' || (receipt.status === 'pending' && !receipt.readError));

  useEffect(() => {
    if (receipt) setForm(toForm(receipt));
  }, [receipt]);
  // While it's being read, check back every few seconds.
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [reading, reload]);

  async function act(path: string, body: unknown = {}, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await post(path, body);
      if (done) setMessage({ tone: 'info', text: done });
      reload();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
    setBusy(false);
  }

  if (!data) return error ? <Banner>{error.message}</Banner> : loading ? <Loading /> : null;
  const r = data.receipt;
  const isPdf = r.mime === 'application/pdf';
  const invalid = form && [form.total, form.tax, form.tip].some((v) => v.trim() !== '' && !Number.isFinite(number(v)));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/receipts" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white">
          <ArrowLeft className="size-4" aria-hidden /> All receipts
        </Link>
        <div className="flex gap-2">
          <Button disabled={busy || Boolean(reading)} onClick={() => act(`/api/receipts/${r.id}/read`, {}, 'Reading it again.')}>
            <RefreshCw className="size-4" aria-hidden />
            Read again
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" aria-hidden />
            Delete
          </Button>
        </div>
      </div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{r.vendor || r.fileName || 'Receipt'}</h1>
      <p className="mb-5 text-sm text-slate-600 dark:text-slate-400">
        {STATUS_LABELS[r.status]}
        {r.confidence && r.status === 'read' ? ` · ${r.confidence} confidence` : ''}
        {r.checked ? ' · checked by you' : r.status === 'read' ? ' · not checked yet' : ''}
      </p>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {r.readError && <Banner tone={r.status === 'failed' ? 'error' : 'warning'}>{r.readError}</Banner>}
      {r.readerNotes && <Banner tone="info">Note from the reader: {r.readerNotes}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card padded={false} className="self-start overflow-hidden">
          {isPdf ? (
            <div className="p-6 text-center">
              <a href={`/api/receipts/${r.id}/file`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 font-medium text-emerald-700 underline dark:text-emerald-400">
                Open the PDF <ExternalLink className="size-4" aria-hidden />
              </a>
            </div>
          ) : (
            <a href={`/api/receipts/${r.id}/file`} target="_blank" rel="noopener" title="Open full size">
              <img src={`/api/receipts/${r.id}/file`} alt={`Receipt${r.vendor ? ` from ${r.vendor}` : ''}`} className="max-h-[75vh] w-full object-contain" />
            </a>
          )}
        </Card>

        <div className="space-y-5">
          <MatchCard receipt={r} suggestions={data.suggestions} busy={busy} act={act} />

          {form && (
            <Card title="Details">
              {reading && <p className="mb-3 text-sm text-slate-500">Being read… the fields fill in when it's done.</p>}
              <form
                className="grid grid-cols-2 gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(
                    `/api/receipts/${r.id}`,
                    {
                      vendor: form.vendor || null,
                      date: form.date || null,
                      total: number(form.total),
                      tax: number(form.tax),
                      tip: number(form.tip),
                      cardLast4: form.cardLast4 || null,
                      category: form.category || null,
                      note: form.note || null,
                      checked: true,
                    },
                    'Saved.'
                  );
                }}
              >
                <Field label="Vendor" className="col-span-2">
                  <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} maxLength={120} />
                </Field>
                <Field label="Date">
                  <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                </Field>
                <Field label="Total paid">
                  <Input inputMode="decimal" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} />
                </Field>
                <Field label="Tax">
                  <Input inputMode="decimal" value={form.tax} onChange={(e) => setForm({ ...form, tax: e.target.value })} />
                </Field>
                <Field label="Tip">
                  <Input inputMode="decimal" value={form.tip} onChange={(e) => setForm({ ...form, tip: e.target.value })} />
                </Field>
                <Field label="Card (last 4)">
                  <Input inputMode="numeric" value={form.cardLast4} onChange={(e) => setForm({ ...form, cardLast4: e.target.value })} maxLength={4} />
                </Field>
                <Field label="Category">
                  <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">None</option>
                    {meta?.categories.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Note" className="col-span-2">
                  <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={1000} placeholder="e.g. supplies for the Elm St unit" />
                </Field>
                <div className="col-span-2 flex flex-wrap items-center gap-3">
                  <Button type="submit" variant="primary" busy={busy} disabled={Boolean(invalid)}>
                    {r.checked ? 'Save' : 'Looks right, save'}
                  </Button>
                  {invalid && <span className="text-xs text-red-700 dark:text-red-400">Amounts must be numbers.</span>}
                  {r.paymentMethod && <span className="text-xs text-slate-500">Paid by {r.paymentMethod}</span>}
                </div>
              </form>
            </Card>
          )}

          {r.items.length > 0 && (
            <Card title="Items on the receipt" padded={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Item</th>
                      <th className={`${TH} text-right`}>Qty</th>
                      <th className={`${TH} text-right`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((item, i) => (
                      <tr key={i} className={TR}>
                        <td className={TD}>{item.description}</td>
                        <td className={`${TD} text-right tabular-nums`}>{item.quantity ?? ''}</td>
                        <td className={`${TD} text-right tabular-nums`}>{money(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Confirm
        open={confirm}
        title="Delete this receipt?"
        confirmLabel="Delete receipt"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await post(`/api/receipts/${r.id}/delete`);
            navigate('/receipts');
          } catch (e) {
            setMessage({ tone: 'error', text: (e as Error).message });
            setBusy(false);
            setConfirm(false);
          }
        }}
      >
        The photo and what was read from it are deleted from your server. A transaction it was matched to is kept.
      </Confirm>
    </>
  );
}

function MatchCard({ receipt: r, suggestions, busy, act }: { receipt: Receipt; suggestions: Suggestion[]; busy: boolean; act: (path: string, body?: unknown, done?: string) => void }) {
  if (r.transaction) {
    const t = r.transaction;
    return (
      <Card title="Matched transaction">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div>
            <div className="font-medium">{t.payee || t.description}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {t.posted} · {t.account} · {r.matchSource === 'auto' ? 'matched automatically' : 'matched by you'}
            </div>
          </div>
          <Amount value={t.amount} className="font-medium" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to={`/transactions?preset=all&kind=all&q=${encodeURIComponent(t.payee || t.description)}`}
            className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            See transaction
          </Link>
          <Button disabled={busy} onClick={() => act(`/api/receipts/${r.id}/unlink`, {}, 'Unlinked. It will not be matched again on its own.')}>
            <Unlink className="size-4" aria-hidden />
            Not this one
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Match to a transaction">
      {r.status !== 'read' ? (
        <Empty>Matching starts once the receipt is read or filled in.</Empty>
      ) : (
        <>
          {suggestions.length ? (
            <ul className="mb-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {suggestions.slice(0, 6).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{s.payee}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {s.posted} · {s.account}
                      {[s.vendorMatch && 'same vendor', s.cardMatch && 'same card', !s.exact && 'amount differs (a tip?)'].filter(Boolean).map((w) => ` · ${w}`)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Amount value={s.amount} />
                    <Button className="min-h-8" disabled={busy} onClick={() => act(`/api/receipts/${r.id}/link`, { transactionId: s.id }, 'Matched.')}>
                      <Link2 className="size-4" aria-hidden />
                      This one
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
              No card or bank transaction matches yet. If the charge hasn't come through, it's matched automatically when it does.
            </p>
          )}
          <Button disabled={busy || r.total === null || !r.date} onClick={() => act(`/api/receipts/${r.id}/cash`, {}, 'Recorded as a cash purchase.')}>
            <Wallet className="size-4" aria-hidden />
            Paid in cash: record it
          </Button>
        </>
      )}
    </Card>
  );
}

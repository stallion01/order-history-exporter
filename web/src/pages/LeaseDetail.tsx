// One lease: its rent month by month, every payment, and its details.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { get, post, useApi } from '../api';
import { useBusiness } from '../business';
import { money, monthLabel } from '../format';
import { PURPOSE_LABELS, STATUS_LABELS, dayText, unitColour } from '../leases';
import type { LeaseDetailData, LeaseList, LeasePayment, Purpose, ScheduleMonth } from '../leases';
import { Banner, Button, Card, Confirm, Empty, Field, Input, Loading, Select, Stat, TD, TH, TR, cx } from '../ui';

const MONTH_TONES: Record<ScheduleMonth['state'], string> = {
  paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  due: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  upcoming: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};
const MONTH_LABELS: Record<ScheduleMonth['state'], string> = { paid: 'Paid', partial: 'Part paid', due: 'Not paid', upcoming: 'Coming up' };

export function LeaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const data = useApi<LeaseDetailData>(`/api/leases/${id}`);
  const [current, setCurrent] = useState<LeaseDetailData | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setCurrent(data.data), [data.data]);

  async function act(fn: () => Promise<LeaseDetailData | unknown>) {
    setError('');
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'lease' in result) setCurrent(result as LeaseDetailData);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (data.error) return <Banner>{data.error.message}</Banner>;
  if (!current) return <Loading />;
  const { lease, schedule, payments } = current;

  return (
    <>
      <Link to="/leases" className="mb-3 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline dark:text-emerald-400">
        <ArrowLeft className="size-4" aria-hidden /> Leases
      </Link>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-400">
            <span className={cx('size-2.5 rounded-full', unitColour(lease.unit))} aria-hidden />
            {lease.unit}
            {lease.ref && <span className="font-normal">· {lease.ref}</span>}
            <span className="font-normal">· {STATUS_LABELS[lease.status]}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{lease.tenant}</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {dayText(lease.start)} to {lease.end ? dayText(lease.end) : 'open-ended'}
            {lease.channel && ` · paid by ${lease.channel}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setEditing(!editing)}>
            <Pencil className="size-4" aria-hidden /> Edit
          </Button>
          <Button onClick={() => setDeleting(true)} aria-label="Delete this lease">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      {error && <Banner>{error}</Banner>}
      {editing && <EditLease detail={current} onSaved={(d) => (setCurrent(d), setEditing(false))} onCancel={() => setEditing(false)} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Rent scheduled" value={money(lease.scheduled || lease.rent || 0)} hint={lease.rent && lease.scheduled !== lease.rent ? `Lease says ${money(lease.rent)}` : undefined} />
        <Stat label="Rent collected" value={money(lease.collected)} />
        <Stat label="Owed so far" value={<span className={lease.owed > 0 ? 'text-amber-700 dark:text-amber-400' : ''}>{money(lease.owed)}</span>} />
        <Stat label="Deposit held" value={money(lease.depositHeld)} hint={lease.deposit ? `Lease says ${money(lease.deposit)}` : undefined} />
      </div>
      {lease.note && <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">{lease.note}</p>}

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Schedule leaseId={lease.id} schedule={schedule} payments={current.payments} act={act} />
        <Payments detail={current} act={act} />
      </div>

      <Confirm
        open={deleting}
        title="Delete this lease?"
        confirmLabel="Delete lease"
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          act(async () => {
            await post(`/api/leases/${lease.id}/delete`);
            navigate('/leases');
          })
        }
      >
        Its rent schedule and payments go too, along with the transactions they added. Transactions from your bank stay, and go back to their usual category.
      </Confirm>
    </>
  );
}

type Act = (fn: () => Promise<LeaseDetailData | unknown>) => Promise<boolean>;

// Rent expected each month, and whether it's been paid (payments fill months in order).
function Schedule({ leaseId, schedule, payments, act }: { leaseId: number; schedule: ScheduleMonth[]; payments: LeasePayment[]; act: Act }) {
  const [rows, setRows] = useState<{ month: string; amount: string; note: string }[] | null>(null);
  const start = () => setRows(schedule.map((m) => ({ month: m.month, amount: String(m.amount), note: m.note || '' })));
  const save = async () => {
    if (!rows) return;
    const ok = await act(() => post(`/api/leases/${leaseId}/schedule`, { months: rows.filter((r) => r.month).map((r) => ({ month: r.month, amount: Number(r.amount) || 0, note: r.note || null })) }));
    if (ok) setRows(null);
  };
  const next = (last?: string) => {
    if (!last) return new Date().toISOString().slice(0, 7);
    const [y, m] = last.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };

  return (
    <Card
      title="Rent by month"
      padded={false}
      actions={
        rows ? (
          <>
            <Button onClick={() => setRows(null)}>Cancel</Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </>
        ) : (
          <Button onClick={start}>
            <Pencil className="size-4" aria-hidden /> Edit
          </Button>
        )
      }
    >
      {rows ? (
        <div className="space-y-2 p-4">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[7.5rem_6rem_1fr_auto] items-center gap-2">
              <Input type="month" aria-label="Month" value={r.month} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)))} />
              <Input type="number" aria-label="Rent" min="0" step="0.01" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Input aria-label="Note" placeholder="Note" value={r.note} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
              <Button variant="ghost" aria-label="Remove this month" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button onClick={() => setRows([...rows, { month: next(rows.at(-1)?.month), amount: rows.at(-1)?.amount || '', note: '' }])}>
            <Plus className="size-4" aria-hidden /> Add a month
          </Button>
        </div>
      ) : schedule.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Month</th>
              <th className={`${TH} text-right`}>Rent</th>
              <th className={TH}>Paid</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((m) => (
              <tr key={m.month} className={TR}>
                <td className={TD}>
                  {monthLabel(m.month)}
                  {m.note && <div className="text-xs text-slate-500 dark:text-slate-400">{m.note}</div>}
                </td>
                <td className={`${TD} text-right tabular-nums`}>{money(m.amount)}</td>
                <td className={TD}>
                  <span className={cx('rounded-full px-2 py-0.5 text-xs font-medium', MONTH_TONES[m.state])}>{MONTH_LABELS[m.state]}</span>
                  {m.state === 'partial' && <span className="ml-1 text-xs text-slate-500">{money(m.paid)}</span>}
                  <MonthPayments ids={m.payments} payments={payments} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No months yet. Edit to add the rent expected each month.</Empty>
      )}
    </Card>
  );
}

// The payments that paid a month, such as rent sent in two or three parts, with a
// link to all of their bank transactions together.
function MonthPayments({ ids, payments }: { ids: number[]; payments: LeasePayment[] }) {
  const paid = ids.map((id) => payments.find((p) => p.id === id)).filter((p): p is LeasePayment => Boolean(p));
  if (!paid.length) return null;
  const transactions = [...new Set(paid.flatMap((p) => p.transactions))];
  const text = paid.map((p) => `${money(p.amount)} on ${dayText(p.date)}`).join(', ');
  return (
    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
      {transactions.length ? (
        <Link to={`/transactions?preset=all&kind=all&${transactions.map((id) => `id=${id}`).join('&')}`} className="hover:underline" title="Open these in transactions">
          {text}
        </Link>
      ) : (
        text
      )}
    </div>
  );
}

type PaymentForm = { date: string; amount: string; purpose: Purpose; channel: string; note: string; verified: boolean; transactionId: string };
const blank = (channel: string | null): PaymentForm => ({ date: new Date().toISOString().slice(0, 10), amount: '', purpose: 'rent', channel: channel || '', note: '', verified: true, transactionId: '' });

function Payments({ detail, act }: { detail: LeaseDetailData; act: Act }) {
  const { lease, payments } = detail;
  const [form, setForm] = useState<PaymentForm | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<{ id: number; posted: string; amount: number; payee: string; account: string }[]>([]);
  useEffect(() => {
    if (form) get<{ transactions: typeof candidates }>(`/api/leases/${lease.id}/candidates`).then((r) => setCandidates(r.transactions), () => setCandidates([]));
  }, [Boolean(form), lease.id]);

  const open = (p?: LeasePayment) => {
    setEditId(p?.id ?? null);
    setForm(
      p
        ? { date: p.date, amount: String(p.amount), purpose: p.purpose, channel: p.channel || '', note: p.note || '', verified: p.verified, transactionId: p.linked ? String(p.transactions[0]) : '' }
        : blank(lease.channel)
    );
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const body = {
      date: form.date,
      amount: Number(form.amount),
      purpose: form.purpose,
      channel: form.channel || null,
      note: form.note || null,
      verified: form.verified,
      transactionId: form.transactionId ? Number(form.transactionId) : null,
    };
    const ok = await act(() => post(editId ? `/api/leases/${lease.id}/payments/${editId}` : `/api/leases/${lease.id}/payments`, body));
    if (ok) setForm(null);
  };
  const set = (patch: Partial<PaymentForm>) => form && setForm({ ...form, ...patch });
  const fitting = candidates.filter((t) => (form?.purpose === 'refund' ? t.amount < 0 : t.amount > 0));
  const signed = (p: LeasePayment) => (p.purpose === 'refund' ? -p.amount : p.amount);

  return (
    <Card
      title="Payments"
      padded={false}
      actions={
        !form && (
          <Button onClick={() => open()}>
            <Plus className="size-4" aria-hidden /> Add a payment
          </Button>
        )
      }
    >
      {form && (
        <form onSubmit={save} className="grid grid-cols-2 gap-3 border-b border-slate-100 p-4 md:grid-cols-3 dark:border-slate-800">
          <Field label="Date">
            <Input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} required />
          </Field>
          <Field label="What for">
            <Select value={form.purpose} onChange={(e) => set({ purpose: e.target.value as Purpose, transactionId: '' })}>
              {(Object.keys(PURPOSE_LABELS) as Purpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount ($)">
            <Input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} required />
          </Field>
          <Field label="Paid by">
            <Input value={form.channel} onChange={(e) => set({ channel: e.target.value })} placeholder="Zelle personal…" />
          </Field>
          <Field label="Note" className="md:col-span-2">
            <Input value={form.note} onChange={(e) => set({ note: e.target.value })} />
          </Field>
          {form.purpose !== 'applied' && (
            <Field label="Already in your bank?" className="col-span-2">
              <Select
                value={form.transactionId}
                onChange={(e) => {
                  const tx = fitting.find((t) => String(t.id) === e.target.value);
                  set({ transactionId: e.target.value, ...(tx ? { amount: String(Math.abs(tx.amount)), date: tx.posted } : {}) });
                }}
              >
                <option value="">No: add it to the ledger</option>
                {fitting.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.posted} · {money(t.amount)} · {t.payee} ({t.account})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={form.verified} onChange={(e) => set({ verified: e.target.checked })} className="size-4" />
            Date and amount confirmed
          </label>
          <div className="col-span-2 flex justify-end gap-2 md:col-span-3">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button type="submit" variant="primary">
              {editId ? 'Save payment' : 'Add payment'}
            </Button>
          </div>
        </form>
      )}
      {payments.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Date</th>
                <th className={TH}>What for</th>
                <th className={`${TH} text-right`}>Amount</th>
                <th className={TH}>In the ledger</th>
                <th className={TH}>
                  <span className="sr-only">Change</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className={TR}>
                  <td className={`${TD} whitespace-nowrap`}>
                    {p.date}
                    {!p.verified && <div className="text-xs text-amber-700 dark:text-amber-400">Not confirmed</div>}
                  </td>
                  <td className={TD}>
                    {PURPOSE_LABELS[p.purpose]}
                    {(p.channel || p.note) && <div className="text-xs text-slate-500 dark:text-slate-400">{[p.channel, p.note].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums whitespace-nowrap', p.purpose === 'rent' || p.purpose === 'applied' ? 'text-emerald-700 dark:text-emerald-400' : '')}>{money(signed(p))}</td>
                  <td className={`${TD} text-xs`}>
                    <Link to={p.transactions.length ? `/transactions?preset=all&kind=all&${p.transactions.map((id) => `id=${id}`).join('&')}` : `/transactions?preset=all&kind=all&q=${encodeURIComponent(lease.tenant)}`} className="text-emerald-700 hover:underline dark:text-emerald-400">
                      {p.linked ? 'Bank transaction' : p.transactions.length > 1 ? `${p.transactions.length} transactions` : 'Added'}
                    </Link>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <Button variant="ghost" aria-label="Change this payment" onClick={() => open(p)}>
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" aria-label="Remove this payment" onClick={() => act(() => post(`/api/leases/${lease.id}/payments/${p.id}/delete`))}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No payments yet.</Empty>
      )}
      <p className="px-4 pb-3 pt-2 text-xs text-slate-500 dark:text-slate-400">
        Rent is rental income. Deposits and refunds are Security Deposits, typed Ignored: held for the tenant, not income or spending. Payments outside the bank go in the account "Rent received outside the bank".
      </p>
    </Card>
  );
}

// The lease's own details.
function EditLease({ detail, onSaved, onCancel }: { detail: LeaseDetailData; onSaved: (d: LeaseDetailData) => void; onCancel: () => void }) {
  const { lease } = detail;
  const units = useApi<LeaseList>('/api/leases').data?.units ?? [];
  const { entities } = useBusiness();
  const [form, setForm] = useState({
    entityId: lease.entityId === null ? '' : String(lease.entityId),
    ref: lease.ref || '',
    unit: lease.unit,
    tenant: lease.tenant,
    phone: lease.phone || '',
    email: lease.email || '',
    start: lease.start,
    end: lease.end || '',
    rent: lease.rent === null ? '' : String(lease.rent),
    monthlyRent: lease.monthlyRent === null ? '' : String(lease.monthlyRent),
    payers: lease.payers || '',
    deposit: lease.deposit === null ? '' : String(lease.deposit),
    channel: lease.channel || '',
    ended: lease.ended,
    note: lease.note || '',
  });
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const unit = units.find((u) => u.name === form.unit);
      onSaved(
        await post<LeaseDetailData>(`/api/leases/${lease.id}`, {
          ...form,
          entityId: form.entityId ? Number(form.entityId) : null,
          ref: form.ref || null,
          propertyId: unit?.id ?? lease.propertyId,
          phone: form.phone || null,
          email: form.email || null,
          end: form.end || null,
          rent: form.rent ? Number(form.rent) : null,
          monthlyRent: form.monthlyRent ? Number(form.monthlyRent) : null,
          deposit: form.deposit ? Number(form.deposit) : null,
          channel: form.channel || null,
          payers: form.payers || null,
          note: form.note || null,
        })
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Lease details" className="mb-5">
      {error && <Banner>{error}</Banner>}
      <form onSubmit={save} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Unit">
          <Input value={form.unit} onChange={set('unit')} list="lease-units" required />
          <datalist id="lease-units">
            {units.map((u) => (
              <option key={u.id} value={u.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Tenant" className="md:col-span-2">
          <Input value={form.tenant} onChange={set('tenant')} required />
        </Field>
        <Field label="Lease ID">
          <Input value={form.ref} onChange={set('ref')} />
        </Field>
        {entities.length > 0 && (
          <Field label="Business" className="col-span-2">
            <Select value={form.entityId} onChange={set('entityId')}>
              <option value="">No business</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Phone">
          <Input value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Starts">
          <Input type="date" value={form.start} onChange={set('start')} required />
        </Field>
        <Field label="Ends">
          <Input type="date" value={form.end} onChange={set('end')} />
        </Field>
        <Field label="Monthly rent ($)">
          <Input type="number" min="0" step="0.01" value={form.monthlyRent} onChange={set('monthlyRent')} />
        </Field>
        <Field label="Or total rent ($)">
          <Input type="number" min="0" step="0.01" value={form.rent} onChange={set('rent')} />
        </Field>
        <Field label="Security deposit ($)">
          <Input type="number" min="0" step="0.01" value={form.deposit} onChange={set('deposit')} />
        </Field>
        <Field label="Paid by">
          <Input value={form.channel} onChange={set('channel')} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={form.ended} onChange={(e) => setForm({ ...form, ended: e.target.checked })} className="size-4" />
          Ended early
        </label>
        <Field label="Names on their bank payments" className="col-span-2 md:col-span-4" hint="Comma-separated, as they appear on deposits; their rent is then found and linked">
          <Input value={form.payers} onChange={set('payers')} />
        </Field>
        <Field label="Note" className="col-span-2 md:col-span-4">
          <Input value={form.note} onChange={set('note')} />
        </Field>
        <div className="col-span-2 flex justify-end gap-2 md:col-span-4">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

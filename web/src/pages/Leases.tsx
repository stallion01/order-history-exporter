// Leases: mid-term tenancies at a glance, and starting a new one.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { post, useApi } from '../api';
import { businessQuery, useBusiness } from '../business';
import { money } from '../format';
import { STATUS_LABELS, dayText, unitColour } from '../leases';
import type { Lease, LeaseDetailData, LeaseList } from '../leases';
import { Banner, Button, Card, Empty, Field, Input, Loading, PageHeader, Select, Stat, cx } from '../ui';

const STATUS_TONES: Record<Lease['status'], string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  upcoming: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  ended: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

export function Leases() {
  const { business, current } = useBusiness();
  const data = useApi<LeaseList>(`/api/leases?${businessQuery(business).slice(1)}`);
  const [adding, setAdding] = useState(false);
  const list = data.data;
  const order: Lease['status'][] = ['active', 'upcoming', 'ended'];

  return (
    <>
      <PageHeader
        title={current ? `Leases: ${current.name}` : 'Leases'}
        description="Mid-term tenancies: rent expected each month, what was paid, and security deposits held. Payments are in your transactions as rental income."
        actions={
          <Button variant="primary" onClick={() => setAdding(!adding)}>
            <Plus className="size-4" aria-hidden /> New lease
          </Button>
        }
      />
      {data.error && <Banner>{data.error.message}</Banner>}
      {adding && list && <NewLease units={list.units} onCancel={() => setAdding(false)} />}
      {!list && data.loading && <Loading />}
      {list && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Active leases" value={list.totals.active} />
            <Stat label={`Rent collected in ${new Date().getFullYear()}`} value={money(list.totals.rentThisYear)} />
            <Stat
              label="Rent owed"
              value={<span className={list.totals.owed > 0 ? 'text-amber-700 dark:text-amber-400' : ''}>{money(list.totals.owed)}</span>}
              hint="Months due so far, less rent paid"
            />
            <Stat label="Deposits held" value={money(list.totals.depositsHeld)} hint="To pay back or keep at the end" />
          </div>
          {!list.leases.length && (
            <Card className="mt-5">
              <Empty>No leases yet. Add one to track its rent and deposit.</Empty>
            </Card>
          )}
          {order.map((status) => {
            const leases = list.leases.filter((l) => l.status === status);
            if (!leases.length) return null;
            return (
              <section key={status} className="mt-6">
                <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-400">{STATUS_LABELS[status]}</h2>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {leases.map((lease) => (
                    <LeaseCard key={lease.id} lease={lease} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}

function LeaseCard({ lease }: { lease: Lease }) {
  const target = lease.scheduled || lease.rent || 0;
  const share = target > 0 ? Math.min(1, lease.collected / target) : 0;
  return (
    <Link
      to={`/leases/${lease.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-emerald-400 hover:shadow dark:border-slate-800 dark:bg-slate-900 dark:hover:border-emerald-600"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={cx('size-2.5 shrink-0 rounded-full', unitColour(lease.unit))} aria-hidden />
            {lease.unit}
            {lease.ref && <span className="text-xs font-normal text-slate-500">{lease.ref}</span>}
          </div>
          <div className="mt-0.5 truncate text-base font-medium">{lease.tenant}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {dayText(lease.start)} to {lease.end ? dayText(lease.end) : 'open-ended'}
          </div>
        </div>
        <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONES[lease.status])}>{STATUS_LABELS[lease.status]}</span>
      </div>
      <div className="mt-3">
        <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400">
          <span>
            Rent collected <span className="font-semibold text-slate-900 dark:text-slate-100">{money(lease.collected)}</span>
          </span>
          <span>of {money(target)}</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="h-full rounded-full bg-[var(--color-lease)]" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {lease.owed > 0 && <span className="font-medium text-amber-700 dark:text-amber-400">{money(lease.owed)} owed</span>}
        <span className="text-slate-600 dark:text-slate-400">Deposit held {money(lease.depositHeld)}</span>
        {lease.unverified > 0 && <span className="text-amber-700 dark:text-amber-400">{lease.unverified} not confirmed</span>}
      </div>
    </Link>
  );
}

// A new lease: who, where and when; the rent schedule and payments follow on its page.
function NewLease({ units, onCancel }: { units: LeaseList['units']; onCancel: () => void }) {
  const navigate = useNavigate();
  const { business, entities } = useBusiness();
  const [entityId, setEntityId] = useState<string>(business ? String(business) : '');
  const [form, setForm] = useState({ unit: units[0]?.name || '', tenant: '', start: '', end: '', rent: '', deposit: '', channel: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const unit = units.find((u) => u.name === form.unit);
      const result = await post<LeaseDetailData>('/api/leases', {
        unit: form.unit,
        propertyId: unit?.id ?? null,
        entityId: entityId ? Number(entityId) : unit?.entityId ?? null,
        tenant: form.tenant,
        start: form.start,
        end: form.end || null,
        rent: form.rent ? Number(form.rent) : null,
        deposit: form.deposit ? Number(form.deposit) : null,
        channel: form.channel || null,
      });
      navigate(`/leases/${result.lease.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card title="New lease" className="mb-5">
      {error && <Banner>{error}</Banner>}
      <form onSubmit={save} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Unit">
          {units.length ? (
            <Select value={form.unit} onChange={set('unit')}>
              {units.map((u) => (
                <option key={u.id} value={u.name}>
                  {u.name}
                </option>
              ))}
            </Select>
          ) : (
            <Input value={form.unit} onChange={set('unit')} required />
          )}
        </Field>
        <Field label="Tenant" className="col-span-1 md:col-span-3">
          <Input value={form.tenant} onChange={set('tenant')} required placeholder="Name(s)" />
        </Field>
        <Field label="Starts">
          <Input type="date" value={form.start} onChange={set('start')} required />
        </Field>
        <Field label="Ends">
          <Input type="date" value={form.end} onChange={set('end')} />
        </Field>
        <Field label="Total rent ($)">
          <Input type="number" min="0" step="0.01" value={form.rent} onChange={set('rent')} />
        </Field>
        <Field label="Security deposit ($)">
          <Input type="number" min="0" step="0.01" value={form.deposit} onChange={set('deposit')} />
        </Field>
        {entities.length > 0 && (
          <Field label="Business" className="col-span-2">
            <Select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">The unit's business</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Paid by" className="col-span-2">
          <Input value={form.channel} onChange={set('channel')} placeholder="Zelle, PayPal, check…" />
        </Field>
        <div className="col-span-2 flex items-end justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Add lease
          </Button>
        </div>
      </form>
    </Card>
  );
}

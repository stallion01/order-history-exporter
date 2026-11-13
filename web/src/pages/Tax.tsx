import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { download, post, useApi } from '../api';
import { placeOptions } from '../filters';
import type { Meta } from '../filters';
import { money, plural, wholeMoney } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, PageHeader, Select, Stat, TD, TH, TR } from '../ui';

const STATUS_LABELS: Record<string, string> = { business: 'Business', personal: 'Personal' };
const FIELD_LABELS: Record<string, string> = {
  zip: 'Delivered to',
  payment: 'Payment method is',
  store: 'Store is',
  category: 'Category is',
  store_card: 'Store, unless on a Business card',
};

export function Tax({ meta, forms, onMetaChange }: { meta: Meta | null; forms: Record<string, { name: string; lines: [string, string][] }>; onMetaChange: () => void }) {
  const lastYear = String(new Date().getFullYear() - 1);
  const [year, setYear] = useState('');
  const [form, setForm] = useState('schedule-c');
  const [zip, setZip] = useState('');
  const [error, setError] = useState('');
  const [rule, setRule] = useState({ field: 'zip', value: '', status: 'business' });
  const [newCategory, setNewCategory] = useState('');

  useEffect(() => {
    if (!year && meta?.years.length) setYear(meta.years.includes(lastYear) ? lastYear : meta.years[0]);
  }, [meta, year, lastYear]);

  const query = new URLSearchParams({ form, ...(year && year !== 'all' ? { year } : {}), ...(zip ? { zip } : {}) }).toString();
  const report = useApi<any>(`/api/tax/report?${query}`);
  const rules = useApi<{ rules: { id: number; field: string; value: string; status: string }[] }>('/api/tax/rules');

  const ruleOptions: [string, string][] = {
    zip: placeOptions(meta),
    payment: (meta?.payments || []).map((p): [string, string] => [p, p]),
    store: (meta?.stores || []).map((s): [string, string] => [s.store, s.name]),
    store_card: (meta?.stores || []).map((s): [string, string] => [s.store, s.name]),
    category: (meta?.categories || []).map((c): [string, string] => [c.name, c.name]),
  }[rule.field] || [];
  const ruleValue = ruleOptions.some(([v]) => v === rule.value) ? rule.value : ruleOptions[0]?.[0] || '';

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await Promise.all([report.reload(), rules.reload()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const addRule = (event: FormEvent) => {
    event.preventDefault();
    act(() => post('/api/tax/rules', { ...rule, value: ruleValue }));
  };

  const addCategory = (event: FormEvent) => {
    event.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    act(async () => {
      await post('/api/categories', { name, scheduleC: null, scheduleE: null });
      setNewCategory('');
      onMetaChange();
    });
  };

  const setLine = (category: Meta['categories'][number], line: string) =>
    act(async () => {
      const key = form === 'schedule-e' ? 'scheduleE' : 'scheduleC';
      await post('/api/categories', { ...category, [key]: line || null });
      onMetaChange();
    });

  const storeName = (value: string) => meta?.stores.find((s) => s.store === value)?.name || value;
  const data = report.data;
  const totals = data?.totals;
  const estimated = data ? data.lines.reduce((sum: number, line: any) => sum + line.estimated, 0) : 0;
  const saveCsv = (detail: string) =>
    download(`/api/tax/export.csv?${query}&detail=${detail}`, `${form}_${year && year !== 'all' ? year : 'all-years'}_${detail}.csv`).catch((e) => setError(e.message));
  const lineKey = form === 'schedule-e' ? 'scheduleE' : 'scheduleC';

  return (
    <>
      <PageHeader
        title="Tax groups"
        description="Business purchases grouped by tax form line, for you or your CPA."
        actions={
          <>
            <Button onClick={() => saveCsv('summary')} disabled={!data}>
              <Download className="size-4" aria-hidden />
              Summary CSV
            </Button>
            <Button onClick={() => saveCsv('items')} disabled={!data}>
              <Download className="size-4" aria-hidden />
              Itemized CSV
            </Button>
          </>
        }
      />
      <Banner tone="info">
        This groups purchases to help you or your tax preparer. It isn't tax advice and can't tell whether a purchase is deductible. Only items marked business are counted. Check line numbers against the
        current year's form.
      </Banner>
      {error && <Banner>{error}</Banner>}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-3xl">
        <Field label="Tax year">
          <Select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="all">All years</option>
            {meta?.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Form">
          <Select value={form} onChange={(e) => setForm(e.target.value)}>
            <option value="schedule-c">Schedule C (business)</option>
            <option value="schedule-e">Schedule E (rental)</option>
          </Select>
        </Field>
        <Field label="Delivered to">
          <Select value={zip} onChange={(e) => setZip(e.target.value)}>
            <option value="">All places</option>
            {placeOptions(meta).map(([z, label]) => (
              <option key={z} value={z}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!data && report.loading && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Business" value={money(totals.business)} hint={plural(totals.businessItems, 'item')} />
            <Stat label="Not reviewed" value={money(totals.unreviewed)} hint={plural(totals.unreviewedItems, 'item')} />
            <Stat label="Personal" value={money(totals.personal)} hint={plural(totals.personalItems, 'item')} />
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {totals.unreviewedItems > 0 && `${plural(totals.unreviewedItems, 'item')} aren't marked business or personal yet, so they aren't counted. `}
            {estimated > 0 && `${plural(estimated, 'counted item')} have estimated amounts because their order has no item prices yet.`}
          </p>

          <Card title={`${data.formName} expense lines`} className="mt-5" padded={false}>
            {data.lines.length || data.unassigned.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Line</th>
                      <th className={TH}>Description</th>
                      <th className={`${TH} text-right`}>Amount</th>
                      <th className={`${TH} text-right`}>Items</th>
                      <th className={TH}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line: any) => (
                      <tr key={line.line} className={TR}>
                        <td className={`${TD} whitespace-nowrap font-medium`}>{line.line}</td>
                        <td className={TD}>{line.label}</td>
                        <td className={`${TD} text-right tabular-nums`}>{money(line.amount)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{line.items}</td>
                        <td className={`${TD} text-slate-500`}>{line.note}</td>
                      </tr>
                    ))}
                    {data.unassigned.map((entry: any) => (
                      <tr key={entry.category} className={`${TR} bg-amber-50/50 dark:bg-amber-950/20`}>
                        <td className={`${TD} whitespace-nowrap`}>None</td>
                        <td className={TD}>{entry.category}</td>
                        <td className={`${TD} text-right tabular-nums`}>{money(entry.amount)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{entry.items}</td>
                        <td className={`${TD} text-slate-500`}>Choose a form line for this category below.</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No business items here yet. Add a rule below, or mark items on the Items page.</Empty>
            )}
          </Card>

          {data.review.length > 0 && (
            <Card title="Large items to review" className="mt-5" padded={false}>
              <p className="px-4 pt-3 text-xs text-slate-500">
                Items of {wholeMoney(data.reviewAmount)} or more may need to be depreciated rather than deducted all at once. Ask your preparer.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.review.map((item: any, index: number) => (
                      <tr key={index} className={TR}>
                        <td className={`${TD} whitespace-nowrap`}>{item.date}</td>
                        <td className={TD}>{item.name}</td>
                        <td className={TD}>{item.category}</td>
                        <td className={`${TD} text-right tabular-nums`}>{money(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
        <Card title="Business and personal rules">
          <p className="mb-3 text-xs text-slate-500">
            For example, everything delivered to a rental's ZIP, or everything on a business card. Your own marks always win, and a personal rule beats a business one. &quot;Store, unless on a Business card&quot; makes that store&apos;s orders and bank charges Personal unless they were paid with a card on an account marked Business.
          </p>
          <form onSubmit={addRule} className="grid grid-cols-2 items-end gap-3">
            <Field label="When">
              <Select value={rule.field} onChange={(e) => setRule({ ...rule, field: e.target.value, value: '' })}>
                {Object.entries(FIELD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Value">
              <Select value={ruleValue} onChange={(e) => setRule({ ...rule, value: e.target.value })} disabled={!ruleOptions.length}>
                {ruleOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Treat as">
              <Select value={rule.field === 'store_card' ? 'personal' : rule.status} onChange={(e) => setRule({ ...rule, status: e.target.value })} disabled={rule.field === 'store_card'}>
                <option value="business">Business</option>
                <option value="personal">Personal</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={!ruleValue}>
              Add rule
            </Button>
          </form>
          <ul className="mt-4 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {(rules.data?.rules || []).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {r.field === 'store_card' ? (
                    <>
                      <span className="font-medium">{storeName(r.value)}</span>, unless on a Business card: Personal
                    </>
                  ) : (
                    <>
                      {FIELD_LABELS[r.field]} <span className="font-medium">{r.field === 'store' ? storeName(r.value) : r.value}</span>: {STATUS_LABELS[r.status]}
                    </>
                  )}
                </span>
                <Button variant="ghost" aria-label={`Remove rule for ${r.value}`} onClick={() => act(() => post('/api/tax/rules/delete', { id: r.id }))}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
            {rules.data && !rules.data.rules.length && <li className="py-2 text-slate-500">No rules yet.</li>}
          </ul>
        </Card>

        <Card title={`Category to ${forms[form]?.name || ''} line`} padded={false}>
          <p className="px-4 pt-3 text-xs text-slate-500">Suggestions only. Change them to match how your preparer files. "Cost of goods sold" is for things bought to resell or to make products from.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {meta?.categories.map((category) => (
                  <tr key={category.name} className={TR}>
                    <td className={TD}>{category.name}</td>
                    <td className={TD}>
                      <Select aria-label={`Form line for ${category.name}`} value={category[lineKey] || ''} onChange={(e) => setLine(category, e.target.value)}>
                        <option value="">Choose a line</option>
                        {forms[form]?.lines.map(([line, label]) => (
                          <option key={line} value={line}>
                            {line}: {label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={TD}>
                      <Select
                        aria-label={`Kind of cost for ${category.name}`}
                        value={category.expenseClass || 'opex'}
                        onChange={(e) => act(async () => {
                          await post('/api/categories', { ...category, expenseClass: e.target.value });
                          onMetaChange();
                        })}
                      >
                        <option value="opex">Operating expense</option>
                        <option value="cogs">Cost of goods sold</option>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form onSubmit={addCategory} className="flex items-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
            <Field label="New category" className="flex-1">
              <Input value={newCategory} maxLength={60} onChange={(e) => setNewCategory(e.target.value)} />
            </Field>
            <Button type="submit">Add</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

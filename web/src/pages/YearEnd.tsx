// Year end: the summary a CPA needs, what's left to decide, capital purchases and
// the asset register, and the package to hand over.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, FileArchive, FileSpreadsheet, FileText, Plus, Trash2 } from 'lucide-react';
import { download, post, useApi } from '../api';
import type { Meta } from '../filters';
import { money, plural } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, PageHeader, Select, TD, TH, TR, cx } from '../ui';

type Forms = Record<string, { name: string; lines: [string, string][] }>;

interface Group {
  entityId: number | null;
  entity: string;
  form: 'C' | 'E';
  lines: { line: string | null; amount: number }[];
  categories: { category: string; amount: number }[];
  opex: number;
  cogs: number;
  capex: number;
  personal: number;
  income: number;
}

interface Asset {
  id: number;
  description: string;
  cost: number;
  placedInService: string;
  entityId: number | null;
  entity: string | null;
  recovery: string | null;
  source: string | null;
  note: string | null;
}

interface YearSummary {
  summary: Group[];
  review: { undecided: number; uncategorised: number; noEntity: number; possibleCapital: number; unmatchedStoreCharges: number; ordersWithoutCharge: number; receiptsToCheck: number };
  possibleCapital: { key: string; txId: number; posted: string; payee: string; item: string | null; category: string; amount: number }[];
  assets: Asset[];
  deMinimis: number;
  recoveryPeriods: [string, string][];
}

export function YearEnd({ meta, forms }: { meta: Meta | null; forms: Forms }) {
  const thisYear = new Date().getFullYear();
  const years = [...new Set([String(thisYear), String(thisYear - 1), ...(meta?.years || [])])].sort().reverse();
  const [year, setYear] = useState(String(thisYear));
  const [entity, setEntity] = useState('');
  const scope = `year=${year}${entity ? `&entity=${entity}` : ''}`;
  const data = useApi<YearSummary>(`/api/cpa/summary?${scope}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const entities = meta?.entities || [];
  const entityName = entity === 'none' ? 'Not assigned' : entities.find((e) => String(e.id) === entity)?.name;

  async function get(kind: 'package.zip' | 'workbook.xlsx' | 'summary.pdf') {
    setBusy(kind);
    setError('');
    const names = { 'package.zip': `CPA package ${year}`, 'workbook.xlsx': `Expense Hub ${year}`, 'summary.pdf': `Year-end summary ${year}` };
    const ext = kind.split('.')[1];
    await download(`/api/cpa/${kind}?${scope}`, `${names[kind]}${entityName ? ` ${entityName}` : ''}.${ext}`).catch((e) => setError(e.message));
    setBusy('');
  }

  const d = data.data;
  return (
    <>
      <PageHeader title="Year end" description="Everything your tax preparer needs for the year: totals by Schedule line, capital purchases, and receipts, ready to download." />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-xl">
        <Field label="Tax year">
          <Select value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </Select>
        </Field>
        <Field label="Business or property">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
            {entities.length > 0 && <option value="none">Not assigned to one</option>}
          </Select>
        </Field>
      </div>

      {(error || data.error) && <Banner>{error || data.error?.message}</Banner>}
      {!d && data.loading && <Loading />}

      {d && (
        <>
          <Card title="Download for your CPA" className="mb-5">
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              The package holds a PDF summary, an Excel workbook (summary, monthly by category, every transaction, income, assets, transfers and what's still to decide) and the year's receipts, named by date, vendor and amount.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={busy === 'package.zip'} onClick={() => get('package.zip')}>
                <FileArchive className="size-4" aria-hidden />
                CPA package (ZIP)
              </Button>
              <Button busy={busy === 'workbook.xlsx'} onClick={() => get('workbook.xlsx')}>
                <FileSpreadsheet className="size-4" aria-hidden />
                Excel workbook
              </Button>
              <Button busy={busy === 'summary.pdf'} onClick={() => get('summary.pdf')}>
                <FileText className="size-4" aria-hidden />
                PDF summary
              </Button>
            </div>
          </Card>

          <Checklist review={d.review} year={year} hasEntities={entities.length > 0} />

          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            {d.summary.length === 0 && (
              <Card className="lg:col-span-2">
                <Empty>No bank or card spending in {year} yet.</Empty>
              </Card>
            )}
            {d.summary.map((g) => (
              <ScheduleCard key={g.entityId ?? 'none'} group={g} forms={forms} />
            ))}
          </div>

          <CapitalCard data={d} onChange={data.reload} />
          <AssetsCard data={d} entities={entities} onChange={data.reload} />
        </>
      )}
    </>
  );
}

function Checklist({ review: r, year, hasEntities }: { review: YearSummary['review']; year: string; hasEntities: boolean }) {
  const items: [number, string, string][] = [
    [r.undecided, 'not marked business or personal', '/review'],
    [r.uncategorised, 'business transactions without a category', `/transactions?preset=years&years=${year}&category=none`],
    ...(hasEntities ? ([[r.noEntity, 'business transactions without a business or property', `/transactions?preset=years&years=${year}&entity=none`]] as [number, string, string][]) : []),
    [r.possibleCapital, 'purchases of $2,500 or more to check (below)', '#capital'],
    [r.unmatchedStoreCharges, 'store charges not matched to an order', `/transactions?preset=years&years=${year}&unmatched=1`],
    [r.ordersWithoutCharge, 'store orders with no matching card charge', `/orders?preset=years&years=${year}`],
    [r.receiptsToCheck, 'receipts not checked', '/receipts?view=review&preset=all'],
  ];
  const open = items.filter(([n]) => n > 0);
  return (
    <Card title="Before you send it" className="mb-5">
      {!open.length ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-4" aria-hidden />
          Everything for {year} is sorted.
        </p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {open.map(([n, label, to]) => (
            <li key={label} className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden />
              {to.startsWith('#') ? (
                <a href={to} className="hover:underline">
                  <strong>{n}</strong> {label}
                </a>
              ) : (
                <Link to={to} className="hover:underline">
                  <strong>{n}</strong> {label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">You can download at any time; whatever is still open is listed in the workbook's Needs review sheet.</p>
    </Card>
  );
}

function ScheduleCard({ group: g, forms }: { group: Group; forms: Forms }) {
  const form = forms[g.form === 'E' ? 'schedule-e' : 'schedule-c'];
  const label = (line: string | null) => (line ? `${line}: ${form?.lines.find(([l]) => l === line)?.[1] ?? ''}` : 'Not on a Schedule line');
  return (
    <Card title={`${g.entity} · ${form?.name ?? `Schedule ${g.form}`}`} padded={false}>
      <table className="w-full text-sm">
        <tbody>
          {g.lines.map((l) => (
            <tr key={l.line ?? 'none'} className={TR}>
              <td className={cx(TD, !l.line && 'text-amber-700 dark:text-amber-400')}>{label(l.line)}</td>
              <td className={`${TD} text-right tabular-nums`}>{money(l.amount)}</td>
            </tr>
          ))}
          <tr className={`${TR} font-semibold`}>
            <td className={TD}>Total expenses</td>
            <td className={`${TD} text-right tabular-nums`}>{money(g.opex + g.cogs)}</td>
          </tr>
          {g.cogs > 0 && (
            <tr className={TR}>
              <td className={`${TD} pl-6 text-slate-600 dark:text-slate-400`}>of which cost of goods sold</td>
              <td className={`${TD} text-right tabular-nums`}>{money(g.cogs)}</td>
            </tr>
          )}
          <tr className={TR}>
            <td className={TD}>Capital purchases (on the asset register)</td>
            <td className={`${TD} text-right tabular-nums`}>{money(g.capex)}</td>
          </tr>
          <tr className={TR}>
            <td className={TD}>Income</td>
            <td className={`${TD} text-right tabular-nums`}>{money(g.income)}</td>
          </tr>
          {g.personal > 0 && (
            <tr className={TR}>
              <td className={`${TD} text-slate-500`}>Personal (left out)</td>
              <td className={`${TD} text-right text-slate-500 tabular-nums`}>{money(g.personal)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {g.lines.some((l) => !l.line) && (
        <p className="px-4 pb-3 text-xs text-slate-500 dark:text-slate-400">
          Some categories have no Schedule line yet. Set them under <Link to="/tax" className="underline">Tax groups</Link>.
        </p>
      )}
    </Card>
  );
}

function CapitalCard({ data, onChange }: { data: YearSummary; onChange: () => void }) {
  const [recovery, setRecovery] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function act(path: string, body: unknown, key: string) {
    setBusy(key);
    setError('');
    try {
      await post(path, body);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy('');
  }
  return (
    <Card title={`Purchases of ${money(data.deMinimis)} or more`} className="mb-5" padded={false}>
      <div id="capital" />
      <p className="px-4 pt-3 text-sm text-slate-600 dark:text-slate-300">
        Items under {money(data.deMinimis)} can usually be expensed straight away. Larger ones (an appliance, a roof, a computer) may need to be capitalized and depreciated instead. Decide each with your preparer: put it on the asset register, or keep it as an expense.
      </p>
      {error && (
        <div className="px-4 pt-3">
          <Banner>{error}</Banner>
        </div>
      )}
      {!data.possibleCapital.length ? (
        <Empty>None waiting.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {data.possibleCapital.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{p.item || p.payee}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {p.posted} · {p.item ? `${p.payee} · ` : ''}
                  {p.category}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">{money(p.amount)}</span>
                <Select aria-label="Recovery period" className="w-auto" value={recovery[p.key] ?? ''} onChange={(e) => setRecovery({ ...recovery, [p.key]: e.target.value })}>
                  <option value="">Recovery period…</option>
                  {data.recoveryPeriods.map(([years, text]) => (
                    <option key={years} value={years}>
                      {text}
                    </option>
                  ))}
                </Select>
                <Button busy={busy === p.key} onClick={() => act('/api/cpa/capital/confirm', { key: p.key, recovery: recovery[p.key] || null }, p.key)}>
                  Capital asset
                </Button>
                <Button variant="ghost" disabled={busy === p.key} onClick={() => act('/api/cpa/capital/dismiss', { key: p.key }, p.key)}>
                  Keep as expense
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AssetsCard({ data, entities, onChange }: { data: YearSummary; entities: Meta['entities']; onChange: () => void }) {
  const empty = { description: '', cost: '', placedInService: '', entityId: '', recovery: '' };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      await post(path, body);
      onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const total = data.assets.reduce((t, a) => t + a.cost, 0);
  return (
    <Card title={`Asset register: placed in service this year (${plural(data.assets.length, 'asset')}, ${money(total)})`} padded={false}>
      {error && (
        <div className="px-4 pt-3">
          <Banner>{error}</Banner>
        </div>
      )}
      {data.assets.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Asset</th>
                <th className={TH}>In service</th>
                <th className={TH}>Business or property</th>
                <th className={TH}>Recovery period</th>
                <th className={`${TH} text-right`}>Cost</th>
                <th className={TH}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.assets.map((a) => (
                <tr key={a.id} className={TR}>
                  <td className={TD}>
                    <div className="font-medium">{a.description}</div>
                    {a.source && <div className="text-xs text-slate-500">{a.source}</div>}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{a.placedInService}</td>
                  <td className={TD}>
                    <Select aria-label={`Business or property for ${a.description}`} value={a.entityId ?? ''} onChange={(e) => run(`/api/assets/${a.id}`, { entityId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Not assigned</option>
                      {entities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className={TD}>
                    <Select aria-label={`Recovery period for ${a.description}`} value={a.recovery ?? ''} onChange={(e) => run(`/api/assets/${a.id}`, { recovery: e.target.value || null })}>
                      <option value="">To decide</option>
                      {data.recoveryPeriods.map(([years]) => (
                        <option key={years} value={years}>
                          {years} years
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{money(a.cost)}</td>
                  <td className={`${TD} text-right`}>
                    <Button variant="ghost" aria-label={`Remove ${a.description}`} disabled={busy} onClick={() => run(`/api/assets/${a.id}/delete`)}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!data.assets.length && <Empty>No assets placed in service this year.</Empty>}
      <form
        className="grid grid-cols-2 gap-3 border-t border-slate-100 p-4 md:grid-cols-[2fr_1fr_1fr_1.3fr_1.3fr_auto] md:items-end dark:border-slate-800"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run('/api/assets', {
            description: form.description.trim(),
            cost: Number(form.cost.replace(/[$,\s]/g, '')),
            placedInService: form.placedInService,
            entityId: form.entityId ? Number(form.entityId) : null,
            recovery: form.recovery || null,
          });
          if (ok) setForm(empty);
        }}
      >
        <Field label="Add an asset" className="col-span-2 md:col-span-1">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. New roof, Elm St" maxLength={200} />
        </Field>
        <Field label="Cost">
          <Input inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
        </Field>
        <Field label="In service">
          <Input type="date" value={form.placedInService} onChange={(e) => setForm({ ...form, placedInService: e.target.value })} />
        </Field>
        <Field label="Business or property">
          <Select value={form.entityId} onChange={(e) => setForm({ ...form, entityId: e.target.value })}>
            <option value="">Not assigned</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Recovery period">
          <Select value={form.recovery} onChange={(e) => setForm({ ...form, recovery: e.target.value })}>
            <option value="">To decide</option>
            {data.recoveryPeriods.map(([years]) => (
              <option key={years} value={years}>
                {years} years
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={!form.description.trim() || !Number(form.cost.replace(/[$,\s]/g, '')) || !form.placedInService}>
          <Plus className="size-4" aria-hidden />
          Add
        </Button>
      </form>
      <p className="px-4 pb-4 text-xs text-slate-500 dark:text-slate-400">
        <Download className="mr-1 inline size-3" aria-hidden />
        Depreciation isn't calculated here; the register gives your preparer what they need to do it.
      </p>
    </Card>
  );
}

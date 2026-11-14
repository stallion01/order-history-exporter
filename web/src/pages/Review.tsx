// Transactions that need a decision, and the rules that save making it again.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from 'lucide-react';
import { get, post, useApi } from '../api';
import { BulkBar, TxRow, txGrid } from '../bank';
import type { Account, Entity, Transaction } from '../bank';
import { useBusiness } from '../business';
import { useFilters } from '../filters';
import type { Meta } from '../filters';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, MultiSelect, PageHeader, Pager, Select, TD, TH, TR } from '../ui';

const PAGE = 50;

interface Rule {
  id: number;
  pattern: string;
  accountId: number | null;
  category: string | null;
  status: string | null;
  kind: string | null;
  entityId: number | null;
  sharedEntities: number[] | null;
}

// Most selected at once: what the bulk change takes.
const MOST = 5000;

export function Review({ meta }: { meta: Meta | null }) {
  const filters = useFilters();
  const { business } = useBusiness();
  const offset = Number(filters.value('page')) || 0;
  const sort = filters.value('sort') || 'date';
  const dir = filters.value('dir') || 'desc';
  const [search, setSearch] = useState(filters.value('q'));
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.value('q')) filters.set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // Everything waiting for review, narrowed by the filters (no date range: all of it).
  const reviewQuery = (extra: Record<string, string | number>) => {
    const out = new URLSearchParams({ review: '1', preset: 'all' });
    for (const key of ['account', 'entity']) for (const v of filters.values(key)) out.append(key, v);
    if (business && !filters.values('entity').length) out.append('entity', String(business));
    for (const key of ['q', 'direction']) if (filters.value(key)) out.set(key, filters.value(key));
    for (const [key, v] of Object.entries(extra)) out.set(key, String(v));
    return out.toString();
  };
  const list = useApi<{ total: number; transactions: Transaction[] }>(`/api/bank/transactions?${reviewQuery({ sort, dir, limit: PAGE, offset })}`);
  const accounts = useApi<{ accounts: Account[] }>('/api/bank/accounts');
  const rules = useApi<{ rules: Rule[]; accounts: { id: number; name: string }[] }>('/api/bank/rules');
  const receipts = useApi<{ counts: { review: number } }>('/api/receipts?limit=1');
  const unmatched = useApi<{ total: number }>(`/api/bank/transactions?unmatched=1&preset=all&limit=1${business ? `&entity=${business}` : ''}`);
  // Everything waiting, in every business, to say when some is outside this one.
  const everywhere = useApi<{ total: number }>('/api/bank/transactions?review=1&kind=normal&preset=all&limit=1');
  const signs = useApi<{ problems: SignProblem[] }>('/api/bank/sign-problems');
  const entities = meta?.entities || [];
  const [selected, setSelected] = useState<number[]>([]);
  const [selecting, setSelecting] = useState(false);
  const categories = meta?.categories.map((c) => c.name) || [];
  // Every transaction that matches, not just this page, a page at a time.
  async function selectAll(total: number) {
    setSelecting(true);
    const ids: number[] = [];
    try {
      for (let at = 0; at < Math.min(total, MOST); at += 200) {
        const page = await get<{ transactions: Transaction[] }>(`/api/bank/transactions?${reviewQuery({ sort, dir, limit: 200, offset: at })}`);
        ids.push(...page.transactions.map((t) => t.id));
        if (page.transactions.length < 200) break;
      }
      setSelected(ids.slice(0, MOST));
    } finally {
      setSelecting(false);
    }
  }
  const filtered = Boolean(filters.value('q') || filters.value('direction') || filters.values('account').length || filters.values('entity').length);
  useEffect(() => setSelected([]), [list.data]);
  const reload = () => {
    list.reload();
    rules.reload();
    signs.reload();
    unmatched.reload();
    everywhere.reload();
  };
  // Waiting in other businesses, or in none, while one business is chosen.
  const elsewhere = business && !filters.values('entity').length && list.data && everywhere.data ? everywhere.data.total - list.data.total : 0;
  const data = list.data;
  // Whether the rules panel is showing, remembered on this device.
  const [rulesOpen, setRulesOpen] = useState(() => {
    try {
      return localStorage.getItem('review-rules-open') !== '0';
    } catch {
      return true;
    }
  });
  const showRules = (open: boolean) => {
    setRulesOpen(open);
    try {
      localStorage.setItem('review-rules-open', open ? '1' : '0');
    } catch {
      // Private browsing: it just isn't remembered.
    }
  };

  return (
    <>
      <PageHeader
        title="Review"
        description="Transactions that need a category, or a business or personal decision. Choices you make here can become rules, so the next ones are done for you."
      />
      {list.error && <Banner>{list.error.message}</Banner>}
      {receipts.data && receipts.data.counts.review > 0 && (
        <Banner tone="warning">
          {receipts.data.counts.review === 1 ? '1 receipt needs' : `${receipts.data.counts.review} receipts need`} checking.{' '}
          <Link to="/receipts?view=review" className="font-medium underline">
            Check receipts
          </Link>
        </Banner>
      )}
      {unmatched.data && unmatched.data.total > 0 && (
        <Banner tone="warning">
          {unmatched.data.total === 1 ? '1 store charge has' : `${unmatched.data.total} store charges have`} no online order matched, so they can't be split by item yet. Bought in a store? Mark it so, or add its receipt.{' '}
          <Link to="/transactions?preset=all&unmatched=1" className="font-medium underline">
            See them
          </Link>
        </Banner>
      )}
      {elsewhere > 0 && !filtered && (
        <Banner tone="info">
          {elsewhere === 1 ? '1 more transaction is' : `${whole(elsewhere)} more transactions are`} waiting in other businesses or not assigned to one.{' '}
          <button type="button" className="font-medium underline" onClick={() => filters.set({ entity: [...entities.map((e) => String(e.id)), 'none'] })}>
            Show everything
          </button>
        </Banner>
      )}
      {signs.data && signs.data.problems.length > 0 && <SignProblems problems={signs.data.problems} onDone={reload} />}
      <form className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <Field label="Search" className="col-span-2 md:col-span-1 xl:col-span-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Payee or description" className="pl-8" />
            {search && (
              <button type="button" onClick={() => setSearch('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-slate-400 hover:text-slate-700" aria-label="Clear the search">
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </Field>
        <MultiSelect label="Account" allLabel="All accounts" options={(accounts.data?.accounts || []).map((a) => [String(a.id), a.name])} selected={filters.values('account')} onChange={(next) => filters.set({ account: next })} />
        {entities.length > 0 && (
          <MultiSelect
            label="Business or property"
            allLabel="All"
            options={[...entities.map((e): [string, string] => [String(e.id), e.name]), ['none', 'Not assigned']]}
            selected={filters.values('entity')}
            onChange={(next) => filters.set({ entity: next })}
          />
        )}
        <Field label="Money in or out">
          <Select value={filters.value('direction')} onChange={(e) => filters.set({ direction: e.target.value })}>
            <option value="">Both</option>
            <option value="out">Spending only</option>
            <option value="in">Income only</option>
          </Select>
        </Field>
      </form>
      <Card
        title={data ? `${whole(data.total)} to review${filtered ? ' (filtered)' : ''}` : 'To review'}
        actions={
          data && data.total > 0 ? (
            <>
              {filtered && (
                <Button
                  className="min-h-8"
                  onClick={() => {
                    setSearch('');
                    filters.set({ q: '', account: [], entity: [], direction: '' });
                  }}
                >
                  Clear filters
                </Button>
              )}
              <Button className="min-h-8" busy={selecting} onClick={() => (selected.length >= Math.min(data.total, MOST) ? setSelected([]) : selectAll(data.total))}>
                {selected.length >= Math.min(data.total, MOST) ? 'Select none' : `Select all ${whole(Math.min(data.total, MOST))}`}
              </Button>
            </>
          ) : undefined
        }
        padded={false}
        className="mb-6"
      >
        <BulkBar ids={selected} categories={categories} entities={entities} onDone={reload} />
        {!data && list.loading && <Loading />}
        {data && !data.transactions.length && (
          <Empty>
            Nothing to review. <Link to="/transactions" className="text-emerald-700 underline dark:text-emerald-400">See all transactions</Link>.
          </Empty>
        )}
        {data && data.transactions.length > 0 && (
          <>
            <div className={`hidden ${txGrid(entities.length > 0)} gap-x-3 border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-600 md:grid dark:border-slate-800 dark:text-slate-400`}>
              <input
                type="checkbox"
                aria-label="Select all on this page"
                className="size-4 accent-emerald-700"
                checked={data.transactions.every((t) => selected.includes(t.id))}
                onChange={(e) => {
                  const page = data.transactions.map((t) => t.id);
                  setSelected((s) => (e.target.checked ? [...new Set([...s, ...page])] : s.filter((id) => !page.includes(id))));
                }}
              />
              <SortButton label="Date" column="date" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              <SortButton label="Payee (click a name to show only it)" column="payee" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              <span>Category</span>
              <span>Business or personal</span>
              {entities.length > 0 && <span>Business or property</span>}
              <span>Type</span>
              <span className="text-right">
                <SortButton label="Amount" column="amount" sort={sort} dir={dir} onSort={(c, d) => filters.set({ sort: c, dir: d })} />
              </span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.transactions.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  categories={categories}
                  entities={entities}
                  selected={selected.includes(tx.id)}
                  onSelect={(checked) => setSelected((s) => (checked ? [...s, tx.id] : s.filter((id) => id !== tx.id)))}
                  onChanged={reload}
                  onPayee={setSearch}
                />
              ))}
            </ul>
          </>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={(next) => filters.set({ page: String(next) })} />}
      </Card>

      {/* On wider screens the rules stay in view at the bottom, scrolling on their own,
          while the page scrolls through the transactions above them. */}
      <div className="md:sticky md:bottom-0 md:z-20 md:-mx-1 md:px-1 md:pb-2">
        {/* A tab in the middle slides the rules down out of the way, and back up. */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => showRules(!rulesOpen)}
            aria-expanded={rulesOpen}
            aria-controls="review-rules"
            className="-mb-px inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 shadow-[0_-6px_14px_-8px_rgba(15,23,42,0.35)] hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {rulesOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
            {rulesOpen ? 'Hide rules' : `Show rules${rules.data?.rules.length ? ` (${rules.data.rules.length})` : ''}`}
          </button>
        </div>
        <div id="review-rules" className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${rulesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden" inert={!rulesOpen}>
            <Rules data={rules.data} categories={categories} entities={entities} onChange={reload} />
          </div>
        </div>
      </div>
    </>
  );
}

function SortButton({ label, column, sort, dir, onSort }: { label: string; column: string; sort: string; dir: string; onSort: (column: string, dir: string) => void }) {
  const active = sort === column;
  return (
    <button
      type="button"
      className={active ? 'text-left text-slate-900 dark:text-white' : 'text-left hover:text-slate-900 dark:hover:text-white'}
      onClick={() => onSort(column, active ? (dir === 'asc' ? 'desc' : 'asc') : column === 'date' || column === 'amount' ? 'desc' : 'asc')}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

const describe = (rule: Rule, entities: Entity[]) => {
  const name = (id: number) => entities.find((e) => e.id === id)?.name ?? 'Removed';
  return [
    rule.category,
    rule.status === 'business' ? 'Business' : rule.status === 'personal' ? 'Personal' : null,
    rule.kind === 'transfer' ? 'Transfer' : rule.kind === 'ignored' ? 'Ignore' : null,
    rule.entityId ? name(rule.entityId) : null,
    rule.sharedEntities ? `Shared equally: ${rule.sharedEntities.map(name).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

function Rules({ data, categories, entities, onChange }: { data: { rules: Rule[]; accounts: { id: number; name: string }[] } | null; categories: string[]; entities: Entity[]; onChange: () => void }) {
  const empty = { pattern: '', accountId: '', category: '', status: '', kind: '', entities: [] as string[] };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accountName = (id: number | null) => (id === null ? 'Any account' : data?.accounts.find((a) => a.id === id)?.name || 'Removed account');

  async function add() {
    setBusy(true);
    setError('');
    try {
      await post('/api/bank/rules', {
        pattern: form.pattern,
        accountId: form.accountId ? Number(form.accountId) : null,
        category: form.category || null,
        status: form.status || null,
        kind: form.kind || null,
        entityId: form.entities.length === 1 ? Number(form.entities[0]) : null,
        sharedEntities: form.entities.length > 1 ? form.entities.map(Number) : null,
      });
      setForm(empty);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  async function remove(id: number) {
    await post(`/api/bank/rules/${id}/delete`).catch((e) => setError(e.message));
    onChange();
  }

  return (
    <Card title="Rules" className="md:max-h-[42vh] md:overflow-y-auto md:shadow-[0_-10px_24px_-12px_rgba(15,23,42,0.35)]">
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
        A rule applies to every transaction whose description contains its text, including ones imported later. The longest matching text wins. Your own edits on a transaction always come first.
      </p>
      {error && <Banner>{error}</Banner>}
      {data?.rules.length ? (
        <div className="relative mb-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>When the description contains</th>
                <th className={TH}>Account</th>
                <th className={TH}>Then</th>
                <th className={TH}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id} className={TR}>
                  <td className={`${TD} font-medium`}>{rule.pattern}</td>
                  <td className={TD}>{accountName(rule.accountId)}</td>
                  <td className={TD}>{describe(rule, entities)}</td>
                  <td className={`${TD} text-right`}>
                    <Button variant="ghost" aria-label={`Remove the rule for ${rule.pattern}`} onClick={() => remove(rule.id)}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No rules yet.</Empty>
      )}
      <form
        className={`grid grid-cols-2 gap-3 md:items-end ${entities.length ? 'md:grid-cols-[2fr_1.3fr_1.3fr_1fr_1.3fr_1fr_auto]' : 'md:grid-cols-[2fr_1.5fr_1.5fr_1fr_1fr_auto]'}`}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Description contains" className="col-span-2 md:col-span-1">
          <Input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="e.g. NATIONAL GRID" minLength={3} required />
        </Field>
        <Field label="Account">
          <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            <option value="">Any account</option>
            {data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option value="">Leave as is</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Business or personal">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="">Leave as is</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
          </Select>
        </Field>
        {entities.length > 0 && (
          <MultiSelect
            label="Business or property"
            allLabel="Leave as is"
            options={entities.map((e): [string, string] => [String(e.id), e.name])}
            selected={form.entities}
            onChange={(next) => setForm({ ...form, entities: next })}
          />
        )}
        <Field label="Type">
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="">Leave as is</option>
            <option value="transfer">Transfer</option>
            <option value="ignored">Ignore</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={form.pattern.trim().length < 3 || !(form.category || form.status || form.kind || form.entities.length)}>
          <Plus className="size-4" aria-hidden />
          Add rule
        </Button>
      </form>
    </Card>
  );
}

interface SignProblem {
  key: string;
  accountId: number;
  account: string;
  from: string;
  count: number;
  duplicates: number;
  examples: { id: number; posted: string; amount: number; payee: string }[];
}

// Imports whose amounts came in the wrong way round: card charges as income, or
// deposits as spending. Usually the same charges also came in the right way round
// from another source, so each shows up twice.
function SignProblems({ problems, onDone }: { problems: SignProblem[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  async function fix(keys: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const done = await post<{ flipped: number; merged: number }>('/api/bank/sign-problems/fix', { keys });
      setMessage({ tone: 'info', text: `Put right: ${plural(done.merged, 'duplicate')} removed, ${plural(done.flipped, 'amount')} turned round.` });
      onDone();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
    setBusy(false);
  }
  return (
    <Card title="Amounts the wrong way round" className="mb-6">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        These imports have money in and money out swapped compared with the rest of the account, for example card charges showing as income. Where the same
        transaction also came in the right way round, the wrong copy is removed; the rest are turned round. Categories, receipts and your own choices are kept.
      </p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {problems.map((p) => (
          <li key={p.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0 text-sm">
              <div className="font-medium">
                {p.account}: {plural(p.count, 'transaction')} from {p.from}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {p.duplicates ? `${whole(p.duplicates)} also came in the right way round. ` : ''}For example:{' '}
                {p.examples.map((e) => `${e.payee} ${money(e.amount)} on ${e.posted}`).join(' · ')}
              </div>
            </div>
            <Button disabled={busy} onClick={() => fix([p.key])}>
              Put right
            </Button>
          </li>
        ))}
      </ul>
      {problems.length > 1 && (
        <Button className="mt-2" variant="primary" disabled={busy} onClick={() => fix(problems.map((p) => p.key))}>
          Put all of them right
        </Button>
      )}
    </Card>
  );
}

// Transactions that need a decision, and the rules that save making it again.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { post, useApi } from '../api';
import { BulkBar, TxRow } from '../bank';
import type { Entity, Transaction } from '../bank';
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

export function Review({ meta }: { meta: Meta | null }) {
  const [offset, setOffset] = useState(0);
  const list = useApi<{ total: number; transactions: Transaction[] }>(`/api/bank/transactions?review=1&sort=date&dir=desc&limit=${PAGE}&offset=${offset}`);
  const rules = useApi<{ rules: Rule[]; accounts: { id: number; name: string }[] }>('/api/bank/rules');
  const receipts = useApi<{ counts: { review: number } }>('/api/receipts?limit=1');
  const unmatched = useApi<{ total: number }>('/api/bank/transactions?unmatched=1&limit=1');
  const signs = useApi<{ problems: SignProblem[] }>('/api/bank/sign-problems');
  const entities = meta?.entities || [];
  const [selected, setSelected] = useState<number[]>([]);
  const categories = meta?.categories.map((c) => c.name) || [];
  useEffect(() => setSelected([]), [list.data]);
  const reload = () => {
    list.reload();
    rules.reload();
    signs.reload();
  };
  const data = list.data;

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
          {unmatched.data.total === 1 ? '1 store charge has' : `${unmatched.data.total} store charges have`} no matching order, so they can't be split by item yet.{' '}
          <Link to="/transactions?preset=all&unmatched=1" className="font-medium underline">
            Match them
          </Link>
        </Banner>
      )}
      {signs.data && signs.data.problems.length > 0 && <SignProblems problems={signs.data.problems} onDone={reload} />}
      <Card title={data ? `${whole(data.total)} to review` : 'To review'} padded={false} className="mb-6">
        <BulkBar ids={selected} categories={categories} entities={entities} onDone={reload} />
        {!data && list.loading && <Loading />}
        {data && !data.transactions.length && (
          <Empty>
            Nothing to review. <Link to="/transactions" className="text-emerald-700 underline dark:text-emerald-400">See all transactions</Link>.
          </Empty>
        )}
        {data && data.transactions.length > 0 && (
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
              />
            ))}
          </ul>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={setOffset} />}
      </Card>

      <Rules data={rules.data} categories={categories} entities={entities} onChange={reload} />
    </>
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
    <Card title="Rules">
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

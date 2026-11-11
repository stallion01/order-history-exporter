// Transactions that need a decision, and the rules that save making it again.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { post, useApi } from '../api';
import { BulkBar, TxRow } from '../bank';
import type { Transaction } from '../bank';
import type { Meta } from '../filters';
import { whole } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, PageHeader, Pager, Select, TD, TH, TR } from '../ui';

const PAGE = 50;

interface Rule {
  id: number;
  pattern: string;
  accountId: number | null;
  category: string | null;
  status: string | null;
  kind: string | null;
}

export function Review({ meta }: { meta: Meta | null }) {
  const [offset, setOffset] = useState(0);
  const list = useApi<{ total: number; transactions: Transaction[] }>(`/api/bank/transactions?review=1&sort=date&dir=desc&limit=${PAGE}&offset=${offset}`);
  const rules = useApi<{ rules: Rule[]; accounts: { id: number; name: string }[] }>('/api/bank/rules');
  const [selected, setSelected] = useState<number[]>([]);
  const categories = meta?.categories.map((c) => c.name) || [];
  useEffect(() => setSelected([]), [list.data]);
  const reload = () => {
    list.reload();
    rules.reload();
  };
  const data = list.data;

  return (
    <>
      <PageHeader
        title="Review"
        description="Transactions that need a category, or a business or personal decision. Choices you make here can become rules, so the next ones are done for you."
      />
      {list.error && <Banner>{list.error.message}</Banner>}
      <Card title={data ? `${whole(data.total)} to review` : 'To review'} padded={false} className="mb-6">
        <BulkBar ids={selected} categories={categories} onDone={reload} />
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
                selected={selected.includes(tx.id)}
                onSelect={(checked) => setSelected((s) => (checked ? [...s, tx.id] : s.filter((id) => id !== tx.id)))}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={setOffset} />}
      </Card>

      <Rules data={rules.data} categories={categories} onChange={reload} />
    </>
  );
}

const describe = (rule: Rule) =>
  [rule.category, rule.status === 'business' ? 'Business' : rule.status === 'personal' ? 'Personal' : null, rule.kind === 'transfer' ? 'Transfer' : rule.kind === 'ignored' ? 'Ignore' : null]
    .filter(Boolean)
    .join(' · ');

function Rules({ data, categories, onChange }: { data: { rules: Rule[]; accounts: { id: number; name: string }[] } | null; categories: string[]; onChange: () => void }) {
  const empty = { pattern: '', accountId: '', category: '', status: '', kind: '' };
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
        <div className="mb-5 overflow-x-auto">
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
                  <td className={TD}>{describe(rule)}</td>
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
        className="grid grid-cols-2 gap-3 md:grid-cols-[2fr_1.5fr_1.5fr_1fr_1fr_auto] md:items-end"
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
        <Field label="Type">
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="">Leave as is</option>
            <option value="transfer">Transfer</option>
            <option value="ignored">Ignore</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={form.pattern.trim().length < 3 || !(form.category || form.status || form.kind)}>
          <Plus className="size-4" aria-hidden />
          Add rule
        </Button>
      </form>
    </Card>
  );
}

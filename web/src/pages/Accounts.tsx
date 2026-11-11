// Bank and card accounts, and the SimpleFIN connection that feeds them.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, Link2, RefreshCw, Trash2, Unplug, Upload } from 'lucide-react';
import { download, post, useApi } from '../api';
import { KIND_LABELS, OWNER_LABELS, SourceBadges, when } from '../bank';
import type { Account, SimplefinStatus } from '../bank';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Confirm, Empty, Field, Input, Loading, PageHeader, Select, cx } from '../ui';

interface AccountsData {
  accounts: Account[];
  simplefin: SimplefinStatus | null;
  reviewCount: number;
}

export function Accounts() {
  const { data, error, loading, reload } = useApi<AccountsData>('/api/bank/accounts');
  const imports = useApi<{ imports: any[] }>('/api/bank/imports');
  const undecided = data?.accounts.filter((a) => a.owner === 'mixed').length || 0;

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Your bank and card accounts. Connect them with SimpleFIN for daily updates, or import statement files."
        actions={
          <Link to="/import" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
            <Upload className="size-4" aria-hidden />
            Import a file
          </Link>
        }
      />
      {error && <Banner>{error.message}</Banner>}
      {!data && loading && <Loading />}
      {data && (
        <>
          <SimplefinCard
            status={data.simplefin}
            onChange={() => {
              reload();
              imports.reload();
            }}
          />
          {undecided > 0 && (
            <Banner tone="warning">
              {plural(undecided, 'account')} {undecided === 1 ? 'is' : 'are'} set to “Mixed”. If an account is only for business or only personal, say so below, and its transactions are sorted for you.
            </Banner>
          )}
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            {data.accounts.map((account) => (
              <AccountCard key={account.id} account={account} onChange={reload} />
            ))}
          </div>
          {!data.accounts.length && (
            <Card className="mb-6">
              <Empty>No accounts yet. Connect SimpleFIN above, or import a statement file.</Empty>
            </Card>
          )}
          <Card title="Recent imports and syncs" padded={false}>
            {!imports.data?.imports.length ? (
              <Empty>Nothing imported yet.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {imports.data.imports.map((i) => (
                  <li key={i.id} className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
                    <span>
                      <span className="font-medium">{i.fileName || i.source}</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {' '}
                        into {i.account || 'a removed account'} · {when(i.at)}
                      </span>
                    </span>
                    <span className="text-slate-600 dark:text-slate-300">
                      {whole(i.added)} new · {whole(i.merged)} matched · {whole(i.skipped)} already there
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function SimplefinCard({ status, onChange }: { status: SimplefinStatus | null; onChange: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (!status) return null;

  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const reply = await post<{ result?: { accounts: number; added: number; newAccounts: number; errors: string[] } }>(path, body);
      if (reply.result) {
        const r = reply.result;
        setNote(`Checked ${plural(r.accounts, 'account')}: ${plural(r.added, 'new transaction')}${r.newAccounts ? `, ${plural(r.newAccounts, 'new account')}` : ''}.`);
      }
      setToken('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    setConfirm(false);
  }

  return (
    <Card title="SimpleFIN" className="mb-6">
      {error && <Banner>{error}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}
      {status.connected ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div className="font-medium text-emerald-700 dark:text-emerald-400">Connected</div>
              <div className="text-slate-600 dark:text-slate-400">
                Last updated {when(status.lastSuccess)}. Checks once a day on its own.
              </div>
            </div>
            <div className="flex gap-2">
              <Button busy={busy} onClick={() => run('/api/bank/simplefin/sync')}>
                <RefreshCw className="size-4" aria-hidden />
                Check now
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
                <Unplug className="size-4" aria-hidden />
                Disconnect
              </Button>
            </div>
          </div>
          {status.errors.length > 0 && (
            <Banner tone="warning">
              <p className="font-medium">SimpleFIN reported problems on the last check:</p>
              <ul className="mt-1 list-disc pl-5">
                {status.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              <p className="mt-1">If a bank needs you to sign in again, do that at SimpleFIN Bridge. Meanwhile you can import that bank's statement files.</p>
            </Banner>
          )}
          <Confirm open={confirm} title="Disconnect SimpleFIN?" confirmLabel="Disconnect" busy={busy} onConfirm={() => run('/api/bank/simplefin/disconnect')} onCancel={() => setConfirm(false)}>
            Daily updates stop. Accounts and transactions already here are kept. To connect again you'll need a new SimpleFIN Token. You can also disable this app's access at SimpleFIN Bridge.
          </Confirm>
        </>
      ) : (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            run('/api/bank/simplefin/connect', { token });
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-slate-700 dark:text-slate-300">
            <li>
              Sign up at{' '}
              <a href="https://bridge.simplefin.org" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-emerald-700 underline dark:text-emerald-400">
                SimpleFIN Bridge
                <ExternalLink className="size-3" aria-hidden />
              </a>{' '}
              (about $15 a year) and connect your banks and cards there.
            </li>
            <li>In SimpleFIN Bridge, make a new app connection. It shows a SimpleFIN Token.</li>
            <li>Paste the token here. It works once, and only gives read access.</li>
          </ol>
          <Field label="SimpleFIN Token">
            <Input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="aHR0cHM6Ly9…" />
          </Field>
          <Button type="submit" variant="primary" busy={busy} disabled={token.trim().length < 10}>
            <Link2 className="size-4" aria-hidden />
            Connect
          </Button>
          <p className="text-xs text-slate-500 dark:text-slate-400">The first update reads the last 90 days, which is as far back as SimpleFIN goes. For older history, import statement files.</p>
        </form>
      )}
    </Card>
  );
}

function AccountCard({ account, onChange }: { account: Account; onChange: () => void }) {
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);

  async function save(changes: Partial<Pick<Account, 'name' | 'kind' | 'owner'>>) {
    setBusy(true);
    setError('');
    try {
      await post(`/api/bank/accounts/${account.id}`, changes);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try {
      await post(`/api/bank/accounts/${account.id}/delete`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    setConfirm(false);
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {account.name}
          {account.last4 && <span className="font-normal text-slate-500 dark:text-slate-400">•••• {account.last4}</span>}
        </span>
      }
      actions={<SourceBadges sources={account.simplefinId ? [...new Set(['simplefin', ...account.sources])] : account.sources} />}
    >
      {error && <Banner>{error}</Banner>}
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Bank</dt>
          <dd>{account.institution || '–'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Balance</dt>
          <dd className={cx('tabular-nums', account.balance === null && 'text-slate-400')}>
            {money(account.balance)}
            {account.balanceDate && <span className="text-xs text-slate-500"> on {account.balanceDate}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Transactions</dt>
          <dd>
            {whole(account.transactions)}
            {account.firstDate && (
              <span className="text-xs text-slate-500">
                {' '}
                ({account.firstDate} to {account.lastDate})
              </span>
            )}
          </dd>
        </div>
      </dl>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== account.name && save({ name: name.trim() })} maxLength={100} />
        </Field>
        <Field label="Type">
          <Select value={account.kind} disabled={busy} onChange={(e) => save({ kind: e.target.value as Account['kind'] })}>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Used for">
          <Select value={account.owner} disabled={busy} onChange={(e) => save({ owner: e.target.value as Account['owner'] })}>
            {Object.entries(OWNER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          to={`/transactions?preset=all&account=${account.id}`}
          className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          View transactions
        </Link>
        <Button disabled={!account.transactions} onClick={() => download(`/api/bank/export.ofx?account=${account.id}&kind=all`, `${account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ofx`).catch((e) => setError(e.message))}>
          <Download className="size-4" aria-hidden />
          Export OFX
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
          <Trash2 className="size-4" aria-hidden />
          Remove
        </Button>
      </div>
      <Confirm open={confirm} title={`Remove ${account.name}?`} confirmLabel="Remove account" busy={busy} onConfirm={remove} onCancel={() => setConfirm(false)}>
        This deletes the account and its {plural(account.transactions, 'transaction')} from Expense Hub, including your edits to them. It can't be undone, except by restoring a backup.
        {account.simplefinId && ' While SimpleFIN is connected, the next update adds the account back; remove it in SimpleFIN Bridge to stop that.'}
      </Confirm>
    </Card>
  );
}

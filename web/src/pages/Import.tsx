// Imports a bank or card statement file: OFX, QFX, QBO or CSV.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ImportHistory } from './ImportHistory';
import { StoreOrdersGuide } from '../storeguide';
import { FileUp } from 'lucide-react';
import { post, useApi } from '../api';
import { Amount, KIND_LABELS, OWNER_LABELS, importLink } from '../bank';
import type { Account } from '../bank';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Field, Input, PageHeader, Select, TD, TH, TR, cx } from '../ui';

const MAX_BYTES = 15 * 1024 * 1024;

interface Mapping {
  date: number;
  description: number;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  memo: number | null;
  reference: number | null;
  flip: boolean;
  direction?: number | null;
  dateOrder: 'mdy' | 'dmy' | 'ymd';
}

type Inspect =
  | {
      type: 'ofx';
      statements: { index: number; last4: string | null; kind: Account['kind']; currency: string; count: number; firstDate: string | null; lastDate: string | null; balance: number | null; accountId: number | null }[];
    }
  | {
      type: 'csv';
      headers: string[];
      sample: string[][];
      mapping: Mapping;
      remembered: boolean;
      accountId: number | null;
      // Why that account: the file overlaps its transactions, the layout was last used for it,
      // or several accounts share the layout and none could be picked.
      accountReason: 'overlap' | 'layout' | 'shared-layout' | null;
      overlap: number;
      count: number;
      firstDate: string | null;
      lastDate: string | null;
      preview: { posted: string; amount: number; description: string }[];
      skipped: { row: number; reason: string }[];
      skippedCount: number;
    };

interface Summary {
  importId: number | null;
  added: number;
  merged: number;
  skipped: number;
  transfers: number;
  signsFixed?: number;
  firstDate: string | null;
  lastDate: string | null;
  accountId: number | null;
  examples: { posted: string; amount: number; description: string; payee: string }[];
}

const NEW = 'new';

export function Import() {
  const accounts = useApi<{ accounts: Account[] }>('/api/bank/accounts');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [statement, setStatement] = useState(0);
  const [accountChoice, setAccountChoice] = useState('');
  const [newAccount, setNewAccount] = useState({ name: '', kind: 'checking' as Account['kind'], owner: 'mixed' as Account['owner'] });
  const [preview, setPreview] = useState<Summary | null>(null);
  const [done, setDone] = useState<Summary | null>(null);
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function choose(chosen: File | undefined) {
    setError('');
    setInspect(null);
    setPreview(null);
    setDone(null);
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) return setError('That file is larger than 15 MB. Export a shorter date range.');
    const content = await chosen.text();
    setFile({ name: chosen.name, content });
    setBusy(true);
    try {
      const result = await post<Inspect>('/api/bank/import/inspect', { fileName: chosen.name, content });
      setInspect(result);
      if (result.type === 'csv') {
        setMapping(result.mapping);
        setAccountChoice(result.accountId ? String(result.accountId) : '');
      } else {
        setStatement(0);
        const first = result.statements[0];
        setAccountChoice(first.accountId ? String(first.accountId) : '');
        setNewAccount((a) => ({ ...a, kind: first.kind, name: a.name || (first.last4 ? `${KIND_LABELS[first.kind]} ${first.last4}` : '') }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  // A changed column choice refreshes the preview of how rows are read.
  useEffect(() => {
    if (!file || inspect?.type !== 'csv' || !mapping || mapping === inspect.mapping) return;
    const timer = setTimeout(async () => {
      try {
        setInspect(await post<Inspect>('/api/bank/import/inspect', { fileName: file.name, content: file.content, mapping }));
      } catch (e) {
        setError((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [mapping]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setPreview(null), [mapping, statement, accountChoice, newAccount]);

  const ready = Boolean(file && inspect && (accountChoice === NEW ? newAccount.name.trim() : accountChoice));
  const body = () => ({
    fileName: file!.name,
    content: file!.content,
    ...(accountChoice === NEW ? { newAccount: { ...newAccount, name: newAccount.name.trim() } } : { accountId: Number(accountChoice) }),
    ...(inspect?.type === 'csv' ? { mapping } : { statement }),
  });

  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const summary = await post<Summary>('/api/bank/import', { ...body(), dryRun });
      if (dryRun) setPreview(summary);
      else {
        setDone(summary);
        setFile(null);
        setInspect(null);
        setPreview(null);
        accounts.reload();
        if (input.current) input.current.value = '';
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <PageHeader title="Import a statement" description="Bring in transactions from a file your bank or card lets you download: OFX, QFX, QBO or CSV. Anything already here is recognised and not added twice. Store orders come from the Chrome extension (below)." />
      {flash && !done && <Banner tone="info">{flash}</Banner>}
      {error && <Banner>{error}</Banner>}
      {done && (
        <Banner tone="info">
          <p>
            Imported {done.added + done.merged + done.skipped} transactions from the file
            {done.transfers ? `, and found ${plural(done.transfers, 'transfer')} between your accounts` : ''}
            {done.signsFixed ? `. ${plural(done.signsFixed, 'amount')} were the wrong way round compared with what's already in the account, and were turned round` : ''}:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {(
              [
                ['added', done.added, 'new'],
                ['merged', done.merged, 'matched to ones already here'],
                ['skipped', done.skipped, 'already imported before'],
              ] as const
            ).map(([outcome, count, label]) => (
              <li key={outcome}>
                {count && done.importId ? (
                  <Link to={importLink(done.importId, outcome)} className="font-medium underline">
                    {whole(count)} {label}
                  </Link>
                ) : (
                  `${whole(count)} ${label}`
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {done.importId && (
              <>
                <Link to={importLink(done.importId)} className="font-medium underline">
                  See everything from this file
                </Link>
                , or{' '}
              </>
            )}
            <Link to="/review" className="font-medium underline">
              review what needs a decision
            </Link>
            .
          </p>
        </Banner>
      )}

      <Card title="1. Choose the file" className="mb-5">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-center text-sm hover:border-emerald-500 dark:border-slate-700">
          <FileUp className="size-8 text-slate-400" aria-hidden />
          <span className="font-medium">{file ? file.name : 'Choose a statement file'}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">.ofx, .qfx, .qbo or .csv, up to 15 MB. Read on your server only.</span>
          <input ref={input} type="file" accept=".ofx,.qfx,.qbo,.csv,.txt,text/csv,application/x-ofx" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
        </label>
      </Card>

      {inspect?.type === 'ofx' && (
        <Card title="2. What's in it" className="mb-5">
          {inspect.statements.length > 1 && (
            <Field label="Statement" className="mb-3 max-w-md">
              <Select
                value={statement}
                onChange={(e) => {
                  const index = Number(e.target.value);
                  setStatement(index);
                  setAccountChoice(inspect.statements[index].accountId ? String(inspect.statements[index].accountId) : '');
                }}
              >
                {inspect.statements.map((s) => (
                  <option key={s.index} value={s.index}>
                    {KIND_LABELS[s.kind]} {s.last4 ? `ending ${s.last4}` : ''} ({plural(s.count, 'transaction')})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {(() => {
            const s = inspect.statements[statement];
            return (
              <p className="text-sm">
                {KIND_LABELS[s.kind]} {s.last4 ? `ending ${s.last4}` : ''}: {plural(s.count, 'transaction')}
                {s.firstDate ? ` from ${s.firstDate} to ${s.lastDate}` : ''}
                {s.balance !== null ? `, balance ${money(s.balance)}` : ''}.{s.accountId ? ' This account was recognised from an earlier file.' : ''}
              </p>
            );
          })()}
        </Card>
      )}

      {inspect?.type === 'csv' && mapping && <CsvMapper inspect={inspect} mapping={mapping} onChange={setMapping} />}

      {inspect && (
        <Card title="3. Which account" className="mb-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Account">
              <Select value={accountChoice} onChange={(e) => setAccountChoice(e.target.value)}>
                <option value="">Choose…</option>
                {accounts.data?.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.last4 ? ` •••• ${a.last4}` : ''}
                  </option>
                ))}
                <option value={NEW}>A new account…</option>
              </Select>
            </Field>
            {accountChoice === NEW && (
              <>
                <Field label="Name">
                  <Input value={newAccount.name} onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })} placeholder="e.g. Business Visa" maxLength={100} />
                </Field>
                <Field label="Type">
                  <Select value={newAccount.kind} onChange={(e) => setNewAccount({ ...newAccount, kind: e.target.value as Account['kind'] })}>
                    {Object.entries(KIND_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Used for">
                  <Select value={newAccount.owner} onChange={(e) => setNewAccount({ ...newAccount, owner: e.target.value as Account['owner'] })}>
                    {Object.entries(OWNER_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
          {inspect.type === 'csv' && inspect.accountReason && (
            <p className={cx('mt-3 text-sm', inspect.accountReason === 'overlap' ? 'text-slate-600 dark:text-slate-300' : 'text-amber-700 dark:text-amber-400')}>
              {inspect.accountReason === 'overlap' && `Chosen because ${plural(inspect.overlap, 'transaction')} in this file are already in that account.`}
              {inspect.accountReason === 'layout' && 'Chosen because the last file with these columns went there. Check it: a bank exports all its accounts the same way.'}
              {inspect.accountReason === 'shared-layout' && 'Several of your accounts use files like this one, so choose which account it is.'}
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            If SimpleFIN already feeds this account, choose that account: transactions both sources report are matched, not doubled.
          </p>
        </Card>
      )}

      {inspect && (
        <Card title="4. Check, then import" className="mb-5">
          {preview && (
            <div className="mb-4 text-sm">
              <p>
                This would add <strong>{plural(preview.added, 'new transaction')}</strong>, match {whole(preview.merged)} to ones already here, and skip {whole(preview.skipped)} already imported
                {preview.transfers ? `. ${plural(preview.transfers, 'transfer')} between your accounts would be found` : ''}
                {preview.signsFixed ? `. ${plural(preview.signsFixed, 'amount')} are the wrong way round compared with what's already in the account, and will be turned round` : ''}.
              </p>
              {preview.examples.length > 0 && (
                <ul className="mt-2 space-y-1 text-slate-600 dark:text-slate-300">
                  {preview.examples.map((ex, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">
                        {ex.posted} · {ex.payee}
                      </span>
                      <Amount value={ex.amount} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!ready} busy={busy && !preview} onClick={() => run(true)}>
              Preview
            </Button>
            <Button variant="primary" disabled={!ready || !preview} busy={busy && Boolean(preview)} onClick={() => run(false)}>
              Import
            </Button>
          </div>
        </Card>
      )}

      <ImportHistory refresh={done?.importId} />
      <div className="mt-6">
        <StoreOrdersGuide />
      </div>
    </>
  );
}

function CsvMapper({ inspect, mapping, onChange }: { inspect: Extract<Inspect, { type: 'csv' }>; mapping: Mapping; onChange: (m: Mapping) => void }) {
  const columns = inspect.headers.map((h, i) => [i, h || `Column ${i + 1}`] as const);
  const twoColumns = mapping.amount === null;
  const column = (key: keyof Mapping, label: string, optional = false) => (
    <Field label={label}>
      <Select value={mapping[key] == null ? '' : String(mapping[key])} onChange={(e) => onChange({ ...mapping, [key]: e.target.value === '' ? null : Number(e.target.value) })}>
        {optional && <option value="">None</option>}
        {columns.map(([i, h]) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Card title="2. Check the columns" className="mb-5">
      {inspect.remembered && <Banner tone="info">This layout was remembered from an earlier file from the same bank.</Banner>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {column('date', 'Date')}
        {column('description', 'Description')}
        <Field label="Amounts are in">
          <Select
            value={twoColumns ? 'two' : 'one'}
            onChange={(e) =>
              onChange(
                e.target.value === 'two'
                  ? { ...mapping, amount: null, debit: mapping.debit ?? 0, credit: mapping.credit ?? 0 }
                  : { ...mapping, amount: mapping.debit ?? 0, debit: null, credit: null }
              )
            }
          >
            <option value="one">One column</option>
            <option value="two">Money out and money in columns</option>
          </Select>
        </Field>
        {twoColumns ? (
          <>
            {column('debit', 'Money out')}
            {column('credit', 'Money in')}
          </>
        ) : (
          <>
            {column('amount', 'Amount')}
            {column('direction', 'Money in or out (a Debit/Credit column)', true)}
          </>
        )}
        <Field label="Dates are written">
          <Select value={mapping.dateOrder} onChange={(e) => onChange({ ...mapping, dateOrder: e.target.value as Mapping['dateOrder'] })}>
            <option value="mdy">Month first (1/31/2026)</option>
            <option value="dmy">Day first (31/1/2026)</option>
            <option value="ymd">Year first (2026-01-31)</option>
          </Select>
        </Field>
        {column('memo', 'Memo (optional)', true)}
        {column('reference', 'Reference number (optional)', true)}
      </div>
      {!twoColumns && mapping.direction == null && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-emerald-700" checked={mapping.flip} onChange={(e) => onChange({ ...mapping, flip: e.target.checked })} />
          Purchases are shown as positive numbers (common on card statements)
        </label>
      )}
      <h3 className="mt-5 mb-2 text-sm font-semibold">
        How the first rows read ({plural(inspect.count, 'transaction')}
        {inspect.firstDate ? `, ${inspect.firstDate} to ${inspect.lastDate}` : ''})
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Date</th>
              <th className={TH}>Description</th>
              <th className={`${TH} text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {inspect.preview.map((row, i) => (
              <tr key={i} className={TR}>
                <td className={`${TD} whitespace-nowrap`}>{row.posted}</td>
                <td className={TD}>{row.description}</td>
                <td className={`${TD} text-right`}>
                  <Amount value={row.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Money out should show as negative, and refunds or deposits as positive. If not, change the columns or the tick box above.</p>
      {inspect.skippedCount > 0 && (
        <Banner tone="warning">
          {plural(inspect.skippedCount, 'row')} can't be read and will be left out
          {inspect.skipped.length ? `, for example row ${inspect.skipped[0].row}: ${inspect.skipped[0].reason}` : ''}.
        </Banner>
      )}
    </Card>
  );
}

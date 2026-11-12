// Earlier imports: a list on the Import page, and a page for each where it can be
// undone or moved to the account it should have gone to.
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRightLeft, Undo2 } from 'lucide-react';
import { post, useApi } from '../api';
import { importLink, when } from '../bank';
import type { Account } from '../bank';
import { plural, whole } from '../format';
import { Banner, Button, Card, Confirm, Empty, Field, Loading, Select, TD, TH, TR, cx } from '../ui';

interface ImportRow {
  id: number;
  at: string;
  source: 'csv' | 'ofx' | 'simplefin';
  fileName: string | null;
  account: string | null;
  accountId: number | null;
  added: number;
  merged: number;
  skipped: number;
  firstDate: string | null;
  lastDate: string | null;
}
interface ImportDetailData extends ImportRow {
  rows: Record<string, number>;
  replayable: boolean;
}

const SOURCE_LABELS = { csv: 'CSV', ofx: 'OFX/QFX', simplefin: 'SimpleFIN' };

export function ImportHistory({ refresh }: { refresh?: unknown }) {
  const list = useApi<{ imports: ImportRow[] }>(`/api/bank/imports${refresh ? `?r=${String(refresh)}` : ''}`);
  return (
    <Card title="Recent imports" className="mb-5" padded={false}>
      {list.error && <Banner>{list.error.message}</Banner>}
      {!list.data && list.loading && <Loading />}
      {list.data && !list.data.imports.length && <Empty>Nothing imported yet.</Empty>}
      {list.data && list.data.imports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>File</th>
                <th className={TH}>Account</th>
                <th className={cx(TH, 'text-right')}>Added</th>
                <th className={cx(TH, 'hidden text-right sm:table-cell')}>Matched</th>
                <th className={cx(TH, 'hidden md:table-cell')}>Dates</th>
              </tr>
            </thead>
            <tbody>
              {list.data.imports.map((i) => (
                <tr key={i.id} className={cx(TR, 'hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    <Link to={`/import/${i.id}`} className="font-medium text-emerald-700 hover:underline dark:text-emerald-400">
                      {when(i.at)}
                    </Link>
                  </td>
                  <td className={cx(TD, 'max-w-48 truncate')} title={i.fileName || undefined}>
                    {i.fileName || SOURCE_LABELS[i.source]}
                  </td>
                  <td className={TD}>{i.account || 'Account deleted'}</td>
                  <td className={cx(TD, 'text-right tabular-nums')}>{whole(i.added)}</td>
                  <td className={cx(TD, 'hidden text-right tabular-nums sm:table-cell')}>{whole(i.merged + i.skipped)}</td>
                  <td className={cx(TD, 'hidden whitespace-nowrap md:table-cell')}>{i.firstDate ? `${i.firstDate} to ${i.lastDate}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ImportDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  const detail = useApi<ImportDetailData>(`/api/bank/imports/${Number(id)}`);
  const accounts = useApi<{ accounts: Account[] }>('/api/bank/accounts');
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState<'undo' | 'move' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(flash || '');

  const back = (
    <Link to="/import" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:underline dark:text-slate-400">
      <ArrowLeft className="size-4" aria-hidden />
      Import
    </Link>
  );
  if (detail.error)
    return (
      <>
        {back}
        <Banner>{detail.error.message}</Banner>
      </>
    );
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const others = (accounts.data?.accounts || []).filter((a) => a.id !== d.accountId);
  const targetName = others.find((a) => String(a.id) === target)?.name || '';
  const fileImport = d.source !== 'simplefin';

  async function undo() {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ removed: number; kept: number }>(`/api/bank/imports/${d.id}/undo`);
      navigate('/import', {
        state: { flash: `The import was undone: ${plural(r.removed, 'transaction')} removed${r.kept ? `, ${whole(r.kept)} kept because another file or the bank feed also has them` : ''}.` },
      });
    } catch (e) {
      setError((e as Error).message);
      setConfirm(null);
    }
    setBusy(false);
  }

  async function move() {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ replayed: boolean; moved: number; merged: number; left: number; importId: number | null }>(`/api/bank/imports/${d.id}/move`, { accountId: Number(target) });
      const text = `Moved to ${targetName}: ${plural(r.moved, 'transaction')} added there${r.merged ? `, ${whole(r.merged)} matched to ones it already had` : ''}.${
        r.left ? ` ${plural(r.left, 'row')} had been matched to ${d.account}'s own transactions and couldn't be moved: import the file again into ${targetName} to bring them in (nothing will be added twice).` : ''
      }`;
      setConfirm(null);
      setTarget('');
      if (r.importId && r.importId !== d.id) navigate(`/import/${r.importId}`, { state: { flash: text } });
      else {
        setMessage(text);
        detail.reload();
      }
    } catch (e) {
      setError((e as Error).message);
      setConfirm(null);
    }
    setBusy(false);
  }

  return (
    <>
      {back}
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{d.fileName || SOURCE_LABELS[d.source]}</h1>
      <p className="mb-5 text-sm text-slate-600 dark:text-slate-400">
        {SOURCE_LABELS[d.source]} imported {when(d.at)} into <span className="font-medium text-slate-800 dark:text-slate-200">{d.account || 'an account since deleted'}</span>
        {d.firstDate ? `, covering ${d.firstDate} to ${d.lastDate}` : ''}.
      </p>
      {message && <Banner tone="info">{message}</Banner>}
      {error && <Banner>{error}</Banner>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="What it did">
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between gap-3">
              <Link to={importLink(d.id, 'added')} className="hover:underline">
                Added as new
              </Link>
              <span className="tabular-nums">{whole(d.rows.added || 0)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <Link to={importLink(d.id, 'merged')} className="hover:underline">
                Matched to transactions already here
              </Link>
              <span className="tabular-nums">{whole(d.rows.merged || 0)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <Link to={importLink(d.id, 'skipped')} className="hover:underline">
                Skipped, already imported
              </Link>
              <span className="tabular-nums">{whole(d.rows.skipped || 0)}</span>
            </li>
          </ul>
          <Link to={importLink(d.id)} className="mt-4 inline-block text-sm font-medium text-emerald-700 underline dark:text-emerald-400">
            See all its transactions
          </Link>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">There you can change categories, or swap money in and out for the whole file.</p>
        </Card>

        {fileImport && (
          <Card title="Wrong account?">
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Moves this import into the right account. Anything that account already has is matched, not added twice.
              {!d.replayable && ' This import is from before files were kept, so only what it added can be moved; rows it matched to the wrong account’s own transactions stay, and importing the file again into the right account brings them in.'}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Move to" className="min-w-56">
                <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose an account…</option>
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.last4 ? ` •••• ${a.last4}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" disabled={!target} onClick={() => setConfirm('move')}>
                <ArrowRightLeft className="size-4" aria-hidden />
                Move
              </Button>
            </div>
          </Card>
        )}

        {fileImport && (
          <Card title="Undo this import">
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Removes the {plural(d.rows.added || 0, 'transaction')} it added, with any changes made to them since, and forgets the rest it matched. Transactions another file or the bank feed also
              reported stay.
            </p>
            <Button variant="danger" onClick={() => setConfirm('undo')}>
              <Undo2 className="size-4" aria-hidden />
              Undo import
            </Button>
          </Card>
        )}
      </div>

      <Confirm open={confirm === 'undo'} title="Undo this import?" confirmLabel="Undo import" busy={busy} onConfirm={undo} onCancel={() => setConfirm(null)}>
        This removes what {d.fileName || 'the file'} added to {d.account}. It can't be reversed, except by importing the file again.
      </Confirm>
      <Confirm open={confirm === 'move'} title={`Move to ${targetName}?`} confirmLabel="Move" busy={busy} onConfirm={move} onCancel={() => setConfirm(null)}>
        The transactions this import added to {d.account} move to {targetName}, and any that {targetName} already has are matched instead of added.
      </Confirm>
    </>
  );
}

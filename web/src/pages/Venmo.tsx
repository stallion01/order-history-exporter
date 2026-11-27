// Venmo statements on My money: picking this month's CSVs, downloaded from venmo.com on
// a phone or computer, and a nudge when it's been a week since the last import.
import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { post, useApi } from '../api';
import { plural } from '../format';
import { Banner, Button, cx } from '../ui';

interface VenmoStatus {
  account: { id: number; name: string } | null;
  lastImport: string | null;
  lastDate: string | null;
  staleDays: number;
  hasKey: boolean;
  keyMade: string | null;
  keyUsed: string | null;
}
interface VenmoResult {
  added: number;
  skipped: number;
  firstDate: string | null;
  lastDate: string | null;
  matchedToBank: number;
  leftOut: { posted: string; description: string; reason: string }[];
  unbalanced: string[];
}

const DAY = 86_400_000;
const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function VenmoImport({ person, onImported }: { person: number | null; onImported: () => void }) {
  const { data, reload } = useApi<VenmoStatus>(`/api/personal/venmo${person ? `?person=${person}` : ''}`);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);
  if (!data) return null;

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const chosen = await Promise.all([...files].map(async (f) => ({ name: f.name, content: await f.text() })));
      const r = await post<VenmoResult>('/api/personal/venmo/import', { files: chosen, person: person ?? undefined });
      const parts = [
        r.added ? `Added ${plural(r.added, 'Venmo row')}${r.firstDate && r.lastDate ? ` from ${shortDate(r.firstDate)} to ${shortDate(r.lastDate)}` : ''}.` : 'Nothing new; these were already here.',
        r.skipped && r.added ? `${plural(r.skipped, 'row')} were already here.` : '',
        r.matchedToBank ? `${plural(r.matchedToBank, 'payment')} matched to the bank, counted once.` : '',
        r.leftOut.length ? `Left out ${plural(r.leftOut.length, 'payment')} not yet complete.` : '',
      ].filter(Boolean);
      const off = r.unbalanced.length ? ` ${r.unbalanced.join(', ')} didn't add up to its balance; tell whoever runs this app.` : '';
      setMessage({ tone: off ? 'warning' : 'info', text: parts.join(' ') + off });
      reload();
      onImported();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const last = data.lastImport ? new Date(data.lastImport) : null;
  const stale = Boolean(data.account) && (!last || Date.now() - last.getTime() > data.staleDays * DAY);
  const button = (label: string, variant: 'primary' | 'secondary' = 'secondary') => (
    <>
      <input ref={input} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={(e) => pick(e.target.files)} />
      <Button variant={variant} busy={busy} onClick={() => input.current?.click()}>
        {!busy && <Upload className="size-4" aria-hidden />}
        {busy ? 'Importing…' : label}
      </Button>
    </>
  );
  const how = 'On venmo.com, open Statements, download each month as CSV, then pick them here. Several at once is fine.';

  return (
    <div className="mb-5">
      {!data.account ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm dark:border-slate-700">
          <p className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
            <span className="font-medium text-slate-900 dark:text-slate-100">Use Venmo?</span> Import your statements so payments that never reach the bank count too. {how} Start with the last 12
            months.
          </p>
          {button('Import Venmo')}
        </div>
      ) : stale ? (
        <Banner tone="warning">
          <p className="mb-2">
            {last ? `Venmo was last imported ${shortDate(data.lastImport!)}.` : 'Venmo hasn’t been imported yet.'} Download your latest statement on venmo.com (Statements, CSV) and import it.
          </p>
          {button('Import Venmo', 'primary')}
        </Banner>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <span>
            Venmo imported {shortDate(data.lastImport!)}
            {data.lastDate && <> · payments to {shortDate(data.lastDate)}</>}
          </span>
          {button('Import more')}
        </div>
      )}
      {message && (
        <p
          className={cx(
            'mt-2 text-sm',
            message.tone === 'error' ? 'text-rose-600 dark:text-rose-400' : message.tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300',
          )}
        >
          {message.text}
        </p>
      )}
      <ChromeSync person={person} status={data} onChange={reload} />
    </div>
  );
}

// The Chrome extension can fetch Venmo statements by itself, from a Chrome signed in
// to Venmo, with a key that only imports into this person's Venmo.
function ChromeSync({ person, status, onChange }: { person: number | null; status: VenmoStatus; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const run = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ key?: string }>(path, { person: person ?? undefined });
      setKey(r.key ?? null);
      setCopied(false);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 text-sm">
      <button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {status.hasKey ? `Syncing from Chrome${status.keyUsed ? `, last ${shortDate(status.keyUsed)}` : ', not used yet'}` : 'Sync from Chrome on a computer instead'}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-slate-600 dark:text-slate-300">
            The Order History Exporter extension can fetch your Venmo statements by itself, from a Chrome where you're signed in to venmo.com: the last 12 months the first time, then whatever is new. It
            needs this app's address and a Venmo sync key, which can only import into your own Venmo.
          </p>
          {error && <Banner>{error}</Banner>}
          {key ? (
            <div className="space-y-1">
              <p className="font-medium">Your Venmo sync key. Copy it into the extension now; it won't be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded bg-slate-100 px-2 py-1.5 font-mono text-xs break-all select-all dark:bg-slate-800">{key}</code>
                <Button
                  onClick={() => {
                    navigator.clipboard?.writeText(key).then(() => setCopied(true), () => setCopied(false));
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run('/api/personal/venmo/key')} busy={busy}>
              {status.hasKey ? 'Make a new key' : 'Make a key'}
            </Button>
            {status.hasKey && (
              <Button variant="ghost" onClick={() => run('/api/personal/venmo/key/delete')} disabled={busy}>
                Stop Chrome sync
              </Button>
            )}
          </div>
          {status.hasKey && !key && <p className="text-xs text-slate-500">A new key replaces the old one, so Chrome will need the new one.</p>}
        </div>
      )}
    </div>
  );
}

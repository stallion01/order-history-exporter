// Receipts: take a photo or upload files, and see what's been read and matched.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, CheckCircle2, FileText, Link2, Loader2, Search, Upload } from 'lucide-react';
import { useApi } from '../api';
import { STATUS_LABELS, uploadReceipt } from '../receipts';
import type { Receipt } from '../receipts';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Empty, Input, Loading, PageHeader, Pager, cx } from '../ui';
import { useFilters } from '../filters';

const PAGE = 60;
type View = 'all' | 'review' | 'unmatched' | 'matched';

interface ListData {
  total: number;
  receipts: Receipt[];
  counts: { total: number; review: number; unmatched: number; reading: number };
  reader: { set: boolean; canStore: boolean };
}

interface Upload {
  name: string;
  state: 'sending' | 'done' | 'duplicate' | 'error';
  message?: string;
  id?: number;
}

export function Receipts() {
  const filters = useFilters();
  const view = (filters.value('view') || 'all') as View;
  const offset = Number(filters.value('page')) || 0;
  const [search, setSearch] = useState(filters.value('q'));
  const query = new URLSearchParams({ view, limit: String(PAGE), offset: String(offset), ...(filters.value('q') ? { q: filters.value('q') } : {}) });
  const list = useApi<ListData>(`/api/receipts?${query}`);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const counts = list.data?.counts;

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.value('q')) filters.set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // While receipts are being read, check back every few seconds.
  useEffect(() => {
    if (!counts?.reading) return;
    const timer = setInterval(list.reload, 4000);
    return () => clearInterval(timer);
  }, [counts?.reading, list.reload]);

  async function send(chosen: FileList | null) {
    if (!chosen?.length) return;
    const batch = [...chosen];
    setUploads((u) => [...batch.map((f) => ({ name: f.name, state: 'sending' as const })), ...u].slice(0, 20));
    for (const file of batch) {
      let update: Partial<Upload>;
      try {
        const result = await uploadReceipt(file);
        update = { state: result.duplicate ? 'duplicate' : 'done', id: result.id };
      } catch (e) {
        update = { state: 'error', message: (e as Error).message };
      }
      setUploads((u) => {
        const index = u.findIndex((x) => x.name === file.name && x.state === 'sending');
        return index < 0 ? u : u.map((x, i) => (i === index ? { ...x, ...update } : x));
      });
      list.reload();
    }
    if (camera.current) camera.current.value = '';
    if (files.current) files.current.value = '';
  }

  const tabs: [View, string, number | undefined][] = [
    ['all', 'All', counts?.total],
    ['review', 'To check', counts?.review],
    ['unmatched', 'Not matched', counts?.unmatched],
    ['matched', 'Matched', undefined],
  ];

  return (
    <>
      <PageHeader title="Receipts" description="Photograph or upload receipts. Each is read, then matched to its card or bank transaction." />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:flex">
        <Button variant="primary" className="min-h-12 sm:min-h-9" onClick={() => camera.current?.click()}>
          <Camera className="size-5 sm:size-4" aria-hidden />
          Take a photo
        </Button>
        <Button className="min-h-12 sm:min-h-9" onClick={() => files.current?.click()}>
          <Upload className="size-5 sm:size-4" aria-hidden />
          Upload files
        </Button>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a photo of a receipt" onChange={(e) => send(e.target.files)} />
        <input ref={files} type="file" accept="image/*,application/pdf" multiple className="sr-only" aria-label="Choose receipt files" onChange={(e) => send(e.target.files)} />
      </div>

      {list.data && !list.data.reader.set && (
        <Banner tone="warning">
          Receipts are kept, but not read automatically until you add an Anthropic API key in <Link to="/settings" className="font-medium underline">Settings</Link>. You can also fill in each one yourself.
        </Banner>
      )}

      {uploads.length > 0 && (
        <Card className="mb-5" padded={false}>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {uploads.map((u, i) => (
              <li key={`${u.name}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="truncate">{u.name}</span>
                <span className={cx('shrink-0 text-xs', u.state === 'error' ? 'text-red-700 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
                  {u.state === 'sending' && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden /> Sending
                    </span>
                  )}
                  {u.state === 'done' && u.id && <Link to={`/receipts/${u.id}`} className="text-emerald-700 underline dark:text-emerald-400">Added</Link>}
                  {u.state === 'duplicate' && u.id && <Link to={`/receipts/${u.id}`} className="underline">Already here</Link>}
                  {u.state === 'error' && u.message}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which receipts">
          {tabs.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => filters.set({ view: value === 'all' ? '' : value })}
              className={cx(
                'rounded-full px-3 py-1.5 text-sm font-medium',
                view === value ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'
              )}
            >
              {label}
              {count ? ` (${whole(count)})` : ''}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
          <Input type="search" className="pl-8" placeholder="Vendor, item or note" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search receipts" />
        </div>
      </div>

      {list.error && <Banner>{list.error.message}</Banner>}
      {!list.data && list.loading && <Loading />}
      {list.data && !list.data.receipts.length && (
        <Card>
          <Empty>{counts?.total ? 'No receipts match.' : 'No receipts yet. Take a photo or upload one to start.'}</Empty>
        </Card>
      )}
      {list.data && list.data.receipts.length > 0 && (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {list.data.receipts.map((r) => (
              <li key={r.id}>
                <ReceiptTile receipt={r} />
              </li>
            ))}
          </ul>
          <Pager offset={offset} pageSize={PAGE} total={list.data.total} onChange={(next) => filters.set({ page: String(next) })} />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{plural(list.data.total, 'receipt')}</p>
        </>
      )}
    </>
  );
}

function ReceiptTile({ receipt: r }: { receipt: Receipt }) {
  const needsLook = r.status === 'failed' || (r.status === 'pending' && r.readError) || (r.status === 'read' && !r.checked);
  return (
    <Link
      to={`/receipts/${r.id}`}
      className="block overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm hover:border-emerald-500 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-800">
        {r.hasThumb ? (
          <img src={`/api/receipts/${r.id}/thumb`} alt="" loading="lazy" className="size-full object-cover object-top" />
        ) : (
          <FileText className="size-10 text-slate-400" aria-hidden />
        )}
      </div>
      <div className="p-2.5 text-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate font-medium">{r.vendor || r.fileName || 'Receipt'}</span>
          <span className="shrink-0 tabular-nums">{money(r.total)}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>{r.date || STATUS_LABELS[r.status]}</span>
          {r.status === 'reading' || (r.status === 'pending' && !r.readError) ? (
            <Loader2 className="size-3.5 animate-spin" aria-label="Being read" />
          ) : r.transactionId ? (
            <Link2 className="size-3.5 text-emerald-600" aria-label="Matched to a transaction" />
          ) : needsLook ? (
            <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">Check</span>
          ) : (
            <CheckCircle2 className="size-3.5" aria-label="Checked" />
          )}
        </div>
      </div>
    </Link>
  );
}

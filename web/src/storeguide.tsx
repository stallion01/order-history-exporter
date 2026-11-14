// How store orders get here: the Chrome extension reads them from each store
// and sends them to this server. A link opens the extension's page when its
// address has been saved in Settings.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, Puzzle } from 'lucide-react';
import { useApi } from './api';
import { Button, Card } from './ui';

export function StoreOrdersGuide({ compact = false }: { compact?: boolean }) {
  const { data } = useApi<{ url: string | null }>('/api/settings/extension');
  const [copied, setCopied] = useState(false);
  const url = data?.url ?? null;
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the address is shown to copy by hand.
    }
  };
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Puzzle className="size-4 text-emerald-600" aria-hidden />
          Get store orders (Amazon, eBay, Walmart and more)
        </span>
      }
      className="mb-5"
    >
      <div className="text-sm text-slate-600 dark:text-slate-300">
        {!compact && (
          <p className="mb-2">
            Store orders come from the Order History Exporter Chrome extension. It reads your order history using the store accounts you're signed in to in Chrome, then sends the orders and their
            items here.
          </p>
        )}
        <ol className="list-decimal space-y-1 pl-5">
          <li>Open the extension{url ? ' with the button below' : ' from Chrome’s toolbar'}.</li>
          <li>Tick the stores, and pick the period, such as a specific year.</li>
          <li>
            Save to <strong>Database</strong> with this server’s address and access token (from <Link to="/settings" className="text-emerald-700 underline dark:text-emerald-400">Settings → Chrome extension</Link>), then start.
          </li>
        </ol>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Only new orders, and orders missing details, are added, so running it again for the same period is safe.</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {url ? (
          <>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center gap-2 rounded-md bg-emerald-700 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
            >
              <ExternalLink className="size-4" aria-hidden />
              Open the extension
            </a>
            <Button onClick={copy} title="If the button doesn't open it, paste this into Chrome's address bar">
              <Copy className="size-4" aria-hidden />
              {copied ? 'Copied' : 'Copy its address'}
            </Button>
          </>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Save the extension’s page address in{' '}
            <Link to="/settings" className="text-emerald-700 underline dark:text-emerald-400">
              Settings
            </Link>{' '}
            to open it from here.
          </span>
        )}
      </div>
    </Card>
  );
}

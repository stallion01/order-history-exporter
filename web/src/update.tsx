// A page left open across an update keeps running the old version. This notices a newer
// one on the server (when the tab comes back into view, and every few minutes) and
// offers to reload.
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './ui';

const EVERY = 10 * 60_000;
// The app's script, which is named after its contents, so a new build has a new name.
const scriptOf = (html: string) => html.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)?.[1] ?? null;
const running = () => {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  return src ?? null;
};

export function UpdateNotice() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const mine = running();
    if (!mine) return; // the development server has no built script
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      try {
        const html = await fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
        const latest = scriptOf(html);
        if (latest && latest !== mine) setNewer(true);
      } catch {
        // Offline for a moment: check again later.
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = setInterval(check, EVERY);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(timer);
    };
  }, []);
  if (!newer) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-md items-center gap-3 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm shadow-lg md:bottom-6 dark:border-emerald-900 dark:bg-slate-900">
      <RefreshCw className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
      <span className="flex-1">Business Hub has been updated. Reload to get the latest version.</span>
      <Button variant="primary" className="min-h-8" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

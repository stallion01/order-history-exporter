import { useState } from 'react';
import type { FormEvent } from 'react';
import { Copy, Eye, KeyRound, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { get, post, useApi } from '../api';
import { Banner, Button, Card, Confirm, Field, Input, PageHeader } from '../ui';
import type { SignedInUser } from './SignIn';

function PasswordCard({ onSignedOut }: { onSignedOut: () => void }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.next !== form.confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError('');
    try {
      await post('/api/auth/password', { current: form.current, next: form.next });
      onSignedOut(); // every session ends when the password changes
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password">
      <form onSubmit={submit} className="space-y-3">
        {error && <Banner>{error}</Banner>}
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required />
        </Field>
        <Field label="New password">
          <Input type="password" autoComplete="new-password" minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" autoComplete="new-password" minLength={10} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
        </Field>
        <p className="text-xs text-slate-500">Changing it signs you out everywhere.</p>
        <Button type="submit" variant="primary" busy={busy}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function TwoFactorCard({ user, onChange }: { user: SignedInUser; onChange: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function run(fn: () => Promise<void>) {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const qrUrl = setup ? URL.createObjectURL(new Blob([setup.qrSvg], { type: 'image/svg+xml' })) : '';

  return (
    <Card title="Two-factor sign-in">
      {error && <Banner>{error}</Banner>}
      {done && <Banner tone="info">{done}</Banner>}
      {user.totpEnabled ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await post('/api/auth/totp/disable', { password, code });
              setDone('Two-factor sign-in is off.');
              onChange();
            });
          }}
        >
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="size-4" aria-hidden /> On. Signing in needs a code from your authenticator app.
          </p>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label="Current code">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <Button type="submit" variant="danger">
            Turn off
          </Button>
        </form>
      ) : setup ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await post('/api/auth/totp/enable', { code });
              setDone('Two-factor sign-in is on.');
              setSetup(null);
              onChange();
            });
          }}
        >
          <p className="text-sm">Scan this with an authenticator app such as 1Password, Google Authenticator or Authy, then enter the code it shows.</p>
          <img src={qrUrl} alt="QR code for your authenticator app" className="size-44 rounded bg-white p-2" />
          <p className="text-xs break-all text-slate-500">
            Can't scan it? Enter this key: <code className="font-mono">{setup.secret}</code>
          </p>
          <Field label="Code from the app">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
          <Button type="submit" variant="primary">
            Turn on
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">Recommended. Even if someone learns your password, they can't sign in without your phone.</p>
          <Button variant="primary" onClick={() => run(async () => setSetup(await post('/api/auth/totp/start')))}>
            <KeyRound className="size-4" aria-hidden />
            Set up two-factor
          </Button>
        </div>
      )}
    </Card>
  );
}

function ExtensionCard() {
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  const reveal = () => get<{ token: string }>('/api/settings/token').then((r) => setToken(r.token), (e) => setError(e.message));
  const copy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const rotate = async () => {
    try {
      setToken((await post<{ token: string }>('/api/settings/token/rotate')).token);
    } catch (e) {
      setError((e as Error).message);
    }
    setConfirm(false);
  };

  return (
    <Card title="Chrome extension">
      {error && <Banner>{error}</Banner>}
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">Server address</dt>
          <dd className="mt-0.5 font-mono break-all">{window.location.origin}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">Access token</dt>
          <dd className="mt-0.5 font-mono break-all">{token || '••••••••••••••••••••••••'}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-500">In the extension, choose Database, then enter these and press Test connection. The token only allows syncing orders.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!token ? (
          <Button onClick={reveal}>
            <Eye className="size-4" aria-hidden /> Show token
          </Button>
        ) : (
          <Button onClick={copy}>
            <Copy className="size-4" aria-hidden /> {copied ? 'Copied' : 'Copy token'}
          </Button>
        )}
        <Button variant="danger" onClick={() => setConfirm(true)}>
          <RefreshCw className="size-4" aria-hidden /> Replace token
        </Button>
      </div>
      <Confirm open={confirm} title="Replace the access token?" confirmLabel="Replace" onCancel={() => setConfirm(false)} onConfirm={rotate}>
        The extension stops syncing until you enter the new token in it.
      </Confirm>
    </Card>
  );
}

// Delivery ZIPs and their place names: found from addresses, or named here.
function PlacesCard({ onChange }: { onChange: () => void }) {
  const list = useApi<{ places: { zip: string; city: string | null; name: string | null; label: string; orders: number }[] }>('/api/places');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  async function save(zip: string, name: string) {
    setError('');
    try {
      await post('/api/places', { zip, name });
      setDrafts((d) => {
        const { [zip]: _gone, ...rest } = d;
        return rest;
      });
      list.reload();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card title="Places" className="lg:col-span-2">
      <div id="places" />
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        Orders are grouped by where they were delivered. Each ZIP shows the city found in its delivery addresses. Give it a name of your own, such as a property, to group several ZIPs together or to fix a city that was read wrongly.
      </p>
      {error && <Banner>{error}</Banner>}
      {!list.data?.places.length ? (
        <p className="text-sm text-slate-500">No delivery addresses yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-600 dark:text-slate-400">
                <th className="px-2 py-1.5 font-medium">ZIP</th>
                <th className="px-2 py-1.5 font-medium">City from addresses</th>
                <th className="px-2 py-1.5 font-medium">Your name for it</th>
                <th className="px-2 py-1.5 text-right font-medium">Orders</th>
              </tr>
            </thead>
            <tbody>
              {list.data.places.map((p) => {
                const draft = drafts[p.zip] ?? p.name ?? '';
                return (
                  <tr key={p.zip} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5 tabular-nums">{p.zip}</td>
                    <td className="px-2 py-1.5">{p.city || <span className="text-slate-400">Not found</span>}</td>
                    <td className="px-2 py-1.5">
                      <Input
                        aria-label={`Name for ${p.zip}`}
                        value={draft}
                        placeholder={p.city || p.zip}
                        maxLength={60}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.zip]: e.target.value }))}
                        onBlur={() => draft.trim() !== (p.name ?? '') && save(p.zip, draft.trim())}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{p.orders}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// The Anthropic API key used to read receipts.
function ReceiptReaderCard() {
  const status = useApi<{ set: boolean; fromEnvironment: boolean; endsWith: string | null; canStore: boolean }>('/api/settings/anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      await post(path, body);
      setKey('');
      status.reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const s = status.data;
  return (
    <Card title="Reading receipts">
      {error && <Banner>{error}</Banner>}
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        Receipts are read by Claude, using your own Anthropic API key, at roughly one or two cents each. Each photo is sent to Anthropic to be read; nothing else from your books is sent.
      </p>
      {s?.set ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
            <Sparkles className="size-4" aria-hidden />
            Key set, ending {s.endsWith}
            {s.fromEnvironment ? ' (from the server settings file)' : ''}
          </span>
          {!s.fromEnvironment && (
            <Button variant="danger" busy={busy} onClick={() => run('/api/settings/anthropic/delete')}>
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            run('/api/settings/anthropic', { apiKey: key });
          }}
        >
          <Field label="Anthropic API key">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="sk-ant-…" />
          </Field>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Make one at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline">
              console.anthropic.com
            </a>
            . It's stored encrypted on your server and never shown again.
          </p>
          <Button type="submit" variant="primary" busy={busy} disabled={!key.trim() || s?.canStore === false}>
            Save key
          </Button>
        </form>
      )}
    </Card>
  );
}

export function Settings({ user, onUserChange, onSignedOut, onMetaChange }: { user: SignedInUser; onUserChange: () => void; onSignedOut: () => void; onMetaChange: () => void }) {
  return (
    <>
      <PageHeader title="Settings" description={`Signed in as ${user.username}.`} />
      <div className="grid gap-5 lg:grid-cols-2">
        <TwoFactorCard user={user} onChange={onUserChange} />
        <ExtensionCard />
        <ReceiptReaderCard />
        <PasswordCard onSignedOut={onSignedOut} />
        <PlacesCard onChange={onMetaChange} />
      </div>
    </>
  );
}

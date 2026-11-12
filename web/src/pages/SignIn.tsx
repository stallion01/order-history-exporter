import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ShieldCheck, Wallet } from 'lucide-react';
import { post } from '../api';
import { Banner, Button, Field, Input } from '../ui';

export interface SignedInUser {
  username: string;
  totpEnabled: boolean;
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-white">
          <Wallet className="size-7 text-emerald-400" aria-hidden />
          <span className="text-xl font-semibold tracking-tight">Business Hub</span>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900 dark:ring-1 dark:ring-slate-800">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 mb-5 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Setup({ onDone }: { onDone: (user: SignedInUser) => void }) {
  const [form, setForm] = useState({ setupCode: '', username: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.password !== form.confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError('');
    try {
      const { user } = await post<{ user: SignedInUser }>('/api/auth/setup', { setupCode: form.setupCode, username: form.username, password: form.password });
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <Shell title="Create your account" subtitle="This is a new install. Create the owner account to protect your financial data.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner>{error}</Banner>}
        <Field label="Setup code">
          <Input value={form.setupCode} onChange={update('setupCode')} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-describedby="setup-help" />
        </Field>
        <p id="setup-help" className="-mt-2 text-xs text-slate-500">
          The access token. On Proxmox, show it with: pct exec &lt;container id&gt; -- cat /var/lib/expense-hub/token
        </p>
        <Field label="Username">
          <Input value={form.username} onChange={update('username')} autoComplete="username" required />
        </Field>
        <Field label="Password">
          <Input type="password" value={form.password} onChange={update('password')} autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={form.confirm} onChange={update('confirm')} autoComplete="new-password" minLength={10} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Create account
        </Button>
      </form>
    </Shell>
  );
}

export function SignIn({ onDone }: { onDone: (user: SignedInUser) => void }) {
  const [form, setForm] = useState({ username: '', password: '', code: '' });
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await post<{ user?: SignedInUser; needCode?: boolean }>('/api/auth/login', { ...form, code: needCode ? form.code : undefined });
      if (result.needCode) setNeedCode(true);
      else if (result.user) onDone(result.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <Shell title="Sign in" subtitle={needCode ? 'Enter the 6-digit code from your authenticator app.' : 'Your books, on your own server.'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner>{error}</Banner>}
        {!needCode ? (
          <>
            <Field label="Username">
              <Input value={form.username} onChange={update('username')} autoComplete="username" required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" value={form.password} onChange={update('password')} autoComplete="current-password" required />
            </Field>
          </>
        ) : (
          <Field label="Authentication code">
            <Input value={form.code} onChange={update('code')} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
          </Field>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          {needCode && <ShieldCheck className="size-4" aria-hidden />}
          {needCode ? 'Verify' : 'Sign in'}
        </Button>
      </form>
    </Shell>
  );
}

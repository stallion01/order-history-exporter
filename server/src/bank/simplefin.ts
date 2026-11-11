// SimpleFIN Bridge: read-only bank and card feeds. The user pastes a one-time
// SimpleFIN Token; claiming it returns an access URL, which is kept encrypted.
// Protocol: https://www.simplefin.org/protocol.html
// The bridge allows about 24 requests a day and 90 days per request, so the daily
// sync makes one request, and the first one asks for the last 90 days.
import type { SecretBox } from '../secrets';
import type { BankStore } from './store';
import type { AccountKind, IncomingTransaction } from './types';

type Fetch = typeof fetch;
const MAX_RANGE_DAYS = 90;
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 7; // banks post some charges days late
const MIN_GAP_MS = 10 * 60 * 1000; // between syncs, to stay well inside the quota
const TIMEOUT_MS = 60000;
const DAY_MS = 86400000;

const KEY_ACCESS = 'simplefin.access';
const KEY_SUCCESS = 'simplefin.lastSuccess';
const KEY_ATTEMPT = 'simplefin.lastAttempt';
const KEY_ERRORS = 'simplefin.lastErrors';

export interface SyncResult {
  accounts: number;
  newAccounts: number;
  added: number;
  merged: number;
  errors: string[];
}

export function decodeToken(token: string): string {
  const text = token.trim();
  if (/^https:\/\//i.test(text)) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
  if (!/^https:\/\/[^\s]+$/i.test(decoded)) throw new Error("That isn't a SimpleFIN Token. Copy the whole token from SimpleFIN Bridge.");
  return decoded;
}

function checkAccessUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error('SimpleFIN sent back something unexpected.');
  }
  if (url.protocol !== 'https:' || !url.username) throw new Error('SimpleFIN sent back something unexpected.');
  return url;
}

export async function claimToken(token: string, fetchImpl: Fetch = fetch): Promise<string> {
  const claimUrl = decodeToken(token);
  // A pasted access URL (with its credentials) is accepted as it is.
  if (/^https:\/\/[^/]*@/i.test(claimUrl)) return checkAccessUrl(claimUrl).toString();
  const response = await fetchImpl(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 403) {
    throw new Error('SimpleFIN says this token was already used or does not exist. Make a new token in SimpleFIN Bridge. If you did not use it yourself, disable it there.');
  }
  if (!response.ok) throw new Error(`SimpleFIN could not claim the token (error ${response.status}).`);
  return checkAccessUrl(await response.text()).toString();
}

// fetch won't send credentials written in a URL, so they go in a header instead.
export async function fetchAccounts(accessUrl: string, range: { start: Date; end: Date }, fetchImpl: Fetch = fetch) {
  const url = new URL(accessUrl);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  const base = url.toString().replace(/\/+$/, '');
  const query = new URLSearchParams({
    version: '2',
    'start-date': String(Math.floor(range.start.getTime() / 1000)),
    'end-date': String(Math.floor(range.end.getTime() / 1000)),
  });
  const response = await fetchImpl(`${base}/accounts?${query}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 402) throw new Error('SimpleFIN says your subscription needs attention. Check your SimpleFIN Bridge account.');
  if (response.status === 403) throw new Error('SimpleFIN refused the connection. It may have been disabled; connect again with a new token.');
  if (!response.ok) throw new Error(`SimpleFIN replied with an error (${response.status}). It will be tried again later.`);
  return (await response.json()) as SimplefinAccountSet;
}

interface SimplefinAccountSet {
  errlist?: { code?: string; msg?: string }[];
  errors?: string[];
  connections?: { conn_id: string; name?: string; org_name?: string }[];
  accounts?: {
    id: string;
    name: string;
    conn_id?: string;
    org?: { name?: string; domain?: string };
    currency?: string;
    balance?: string;
    'balance-date'?: number;
    transactions?: { id: string; posted: number; amount: string; description?: string; payee?: string; memo?: string; pending?: boolean }[];
  }[];
}

const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

export function guessKind(name: string): AccountKind {
  if (/card|visa|master ?card|amex|american express|discover|credit|rewards/i.test(name)) return 'credit';
  if (/saving|money market/i.test(name)) return 'savings';
  if (/checking|chk|spending/i.test(name)) return 'checking';
  return 'other';
}

export function simplefinService(store: BankStore, box: SecretBox, fetchImpl: Fetch = fetch) {
  let running: Promise<SyncResult> | null = null;

  const accessUrl = () => {
    const sealed = store.getSetting(KEY_ACCESS);
    return sealed ? box.open(sealed) : null;
  };

  function status() {
    return {
      connected: Boolean(store.getSetting(KEY_ACCESS)),
      lastSuccess: store.getSetting(KEY_SUCCESS),
      lastAttempt: store.getSetting(KEY_ATTEMPT),
      errors: JSON.parse(store.getSetting(KEY_ERRORS) || '[]') as string[],
      syncing: Boolean(running),
    };
  }

  async function runSync(username: string | null): Promise<SyncResult> {
    const access = accessUrl();
    if (!access) throw new Error('SimpleFIN is not connected.');
    const attemptAt = new Date();
    store.setSetting(KEY_ATTEMPT, attemptAt.toISOString());
    const result: SyncResult = { accounts: 0, newAccounts: 0, added: 0, merged: 0, errors: [] };
    try {
      const lastSuccess = store.getSetting(KEY_SUCCESS);
      let start = new Date(lastSuccess ? Date.parse(lastSuccess) - OVERLAP_DAYS * DAY_MS : attemptAt.getTime() - FIRST_SYNC_DAYS * DAY_MS);
      const seen = new Set<string>();
      while (start < attemptAt) {
        const end = new Date(Math.min(start.getTime() + MAX_RANGE_DAYS * DAY_MS, attemptAt.getTime() + DAY_MS));
        const data = await fetchAccounts(access, { start, end }, fetchImpl);
        for (const e of data.errlist || []) if (e.msg) result.errors.push(e.msg);
        for (const e of data.errors || []) if (typeof e === 'string') result.errors.push(e);
        const institutions = new Map((data.connections || []).map((c) => [c.conn_id, c.name || c.org_name || null]));
        for (const raw of data.accounts || []) {
          let id = store.accountForSimplefin(raw.id);
          if (!id) {
            id = store.createAccount({
              name: String(raw.name || 'Account').slice(0, 100),
              institution: ((raw.conn_id && institutions.get(raw.conn_id)) || raw.org?.name || null)?.slice(0, 100) ?? null,
              kind: guessKind(raw.name || ''),
              owner: 'mixed',
              currency: /^[A-Z]{3}$/.test(raw.currency || '') ? raw.currency : 'USD',
              simplefinId: raw.id,
            });
            result.newAccounts++;
          }
          if (!seen.has(raw.id)) {
            seen.add(raw.id);
            result.accounts++;
          }
          const balance = Number(raw.balance);
          if (Number.isFinite(balance)) store.setBalance(id, balance, raw['balance-date'] ? isoDate(raw['balance-date']) : null);
          // Pending charges change id when they post, so only posted ones are kept.
          const transactions: IncomingTransaction[] = (raw.transactions || [])
            .filter((t) => !t.pending && t.posted > 0 && Number.isFinite(Number(t.amount)))
            .map((t) => ({ externalId: String(t.id), posted: isoDate(t.posted), amount: Number(t.amount), description: t.description || t.payee || 'Transaction', memo: t.memo || null, payee: t.payee || null }));
          const summary = store.importTransactions(id, 'simplefin', transactions, { fileName: 'SimpleFIN sync', username });
          result.added += summary.added;
          result.merged += summary.merged;
          store.markSynced(id);
        }
        start = end;
      }
      store.setSetting(KEY_SUCCESS, attemptAt.toISOString());
    } catch (err) {
      result.errors.push((err as Error).message);
    }
    store.setSetting(KEY_ERRORS, JSON.stringify(result.errors.slice(0, 20)));
    return result;
  }

  return {
    status,
    async connect(token: string, username: string | null) {
      const access = await claimToken(token, fetchImpl);
      store.setSetting(KEY_ACCESS, box.seal(access));
      store.setSetting(KEY_SUCCESS, null);
      store.setSetting(KEY_ERRORS, null);
      return this.sync(username, { force: true });
    },
    disconnect() {
      for (const key of [KEY_ACCESS, KEY_SUCCESS, KEY_ATTEMPT, KEY_ERRORS]) store.setSetting(key, null);
    },
    // One sync at a time, and not more often than every few minutes.
    async sync(username: string | null, { force = false } = {}): Promise<SyncResult> {
      if (running) return running;
      const last = store.getSetting(KEY_ATTEMPT);
      if (!force && last && Date.now() - Date.parse(last) < MIN_GAP_MS) {
        throw new Error('SimpleFIN was checked a few minutes ago. Try again in a little while.');
      }
      running = runSync(username).finally(() => {
        running = null;
      });
      return running;
    },
    // Whether the daily sync is due.
    due(now = new Date()) {
      if (!store.getSetting(KEY_ACCESS) || running) return false;
      const last = store.getSetting(KEY_ATTEMPT);
      return !last || now.getTime() - Date.parse(last) > 20 * 60 * 60 * 1000;
    },
  };
}

export type SimplefinService = ReturnType<typeof simplefinService>;

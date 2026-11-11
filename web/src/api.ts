// Talks to the server. Every request carries the header the server uses to
// tell this app's requests from forged ones.
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const signedOutListeners = new Set<() => void>();
export function onSignedOut(listener: () => void) {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

async function call(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'expense-hub', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && !path.startsWith('/api/auth/')) signedOutListeners.forEach((listener) => listener());
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error || `The server replied with an error (${response.status}).`);
  }
  return response;
}

export const get = async <T>(path: string): Promise<T> => (await call(path)).json();
export const post = async <T>(path: string, body: unknown = {}): Promise<T> => (await call(path, 'POST', body)).json();

export async function download(path: string, filename: string): Promise<void> {
  const blob = await (await call(path)).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Loads `path` whenever it changes. Older replies are ignored if a newer request started.
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: Boolean(path) });
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await get<T>(path);
      if (id === latest.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === latest.current) setState((s) => ({ ...s, error: error as Error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

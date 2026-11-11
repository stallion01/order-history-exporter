import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { get, onSignedOut, post } from './api';
import type { Meta } from './filters';
import { Layout } from './Layout';
import { Accounts } from './pages/Accounts';
import { Dashboard } from './pages/Dashboard';
import { Import } from './pages/Import';
import { More } from './pages/More';
import { ReceiptDetail } from './pages/ReceiptDetail';
import { Receipts } from './pages/Receipts';
import { Review } from './pages/Review';
import { Transactions } from './pages/Transactions';
import { Items } from './pages/Items';
import { Orders } from './pages/Orders';
import { Settings } from './pages/Settings';
import { Setup as SetupScreen, SignIn } from './pages/SignIn';
import type { SignedInUser } from './pages/SignIn';
import { Tax } from './pages/Tax';
import { Banner, Loading } from './ui';

type Forms = Record<string, { name: string; lines: [string, string][] }>;

function App() {
  const [auth, setAuth] = useState<{ loading: boolean; setupNeeded: boolean; user: SignedInUser | null }>({ loading: true, setupNeeded: false, user: null });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [forms, setForms] = useState<Forms>({});
  const [error, setError] = useState('');

  const loadAuth = useCallback(async () => {
    try {
      const state = await get<{ setupNeeded: boolean; user: SignedInUser | null }>('/api/auth/state');
      setAuth({ loading: false, ...state });
    } catch (e) {
      setError((e as Error).message);
      setAuth((a) => ({ ...a, loading: false }));
    }
  }, []);

  // Filter choices and categories, shared by every page.
  const loadMeta = useCallback(async () => {
    try {
      const [status, categories] = await Promise.all([get<any>('/api/status'), get<{ categories: Meta['categories']; forms: Forms }>('/api/categories')]);
      setMeta({ stores: status.stores, payments: status.payments, zips: status.zips, years: status.years, categories: categories.categories });
      setForms(categories.forms);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadAuth();
    return onSignedOut(() => setAuth({ loading: false, setupNeeded: false, user: null }));
  }, [loadAuth]);

  useEffect(() => {
    if (auth.user) loadMeta();
  }, [auth.user, loadMeta]);

  const signOut = async () => {
    await post('/api/auth/logout').catch(() => {});
    setAuth({ loading: false, setupNeeded: false, user: null });
  };

  if (auth.loading) return <Loading />;
  if (!auth.user) {
    return (
      <>
        {error && <Banner>{error}</Banner>}
        {auth.setupNeeded ? <SetupScreen onDone={(user) => setAuth({ loading: false, setupNeeded: false, user })} /> : <SignIn onDone={(user) => setAuth({ loading: false, setupNeeded: false, user })} />}
      </>
    );
  }

  return (
    <Layout username={auth.user.username} onSignOut={signOut}>
      {error && <Banner>{error}</Banner>}
      <Routes>
        <Route path="/" element={<Dashboard meta={meta} />} />
        <Route path="/transactions" element={<Transactions meta={meta} />} />
        <Route path="/review" element={<Review meta={meta} />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/import" element={<Import />} />
        <Route path="/more" element={<More />} />
        <Route path="/receipts" element={<Receipts />} />
        <Route path="/receipts/:id" element={<ReceiptDetail meta={meta} />} />
        <Route path="/orders" element={<Orders meta={meta} />} />
        <Route path="/items" element={<Items meta={meta} onMetaChange={loadMeta} />} />
        <Route path="/tax" element={<Tax meta={meta} forms={forms} onMetaChange={loadMeta} />} />
        <Route path="/settings" element={<Settings user={auth.user} onUserChange={loadAuth} onSignedOut={() => setAuth({ loading: false, setupNeeded: false, user: null })} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

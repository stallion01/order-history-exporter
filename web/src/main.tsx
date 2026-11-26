import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { get, onSignedOut, post } from './api';
import type { Meta } from './filters';
import { Layout } from './Layout';
import { BusinessProvider } from './business';
import { Accounts } from './pages/Accounts';
import { Personal } from './pages/Personal';
import { PersonalSearch } from './pages/PersonalSearch';
import { Wealth } from './pages/Wealth';
import { Retirement } from './pages/Retirement';
import { Dashboard } from './pages/Dashboard';
import { Import } from './pages/Import';
import { ImportDetail } from './pages/ImportHistory';
import { More } from './pages/More';
import { ReceiptDetail } from './pages/ReceiptDetail';
import { Receipts } from './pages/Receipts';
import { Review } from './pages/Review';
import { Transactions } from './pages/Transactions';
import { YearEnd } from './pages/YearEnd';
import { Items } from './pages/Items';
import { Orders } from './pages/Orders';
import { Settings } from './pages/Settings';
import { StayDetail } from './pages/StayDetail';
import { Stays } from './pages/Stays';
import { LeaseDetail } from './pages/LeaseDetail';
import { Leases } from './pages/Leases';
import { Hours } from './pages/Hours';
import { Guests } from './pages/Guests';
import { ProfitLoss } from './pages/ProfitLoss';
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
      const [status, categories, entities] = await Promise.all([
        get<any>('/api/status'),
        get<{ categories: Meta['categories']; forms: Forms }>('/api/categories'),
        get<{ entities: Meta['entities'] }>('/api/entities'),
      ]);
      setMeta({
        stores: status.stores,
        payments: status.payments,
        zips: status.zips,
        places: status.places || [],
        years: status.years,
        categories: categories.categories,
        entities: entities.entities,
      });
      setForms(categories.forms);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadAuth();
    return onSignedOut(() => setAuth({ loading: false, setupNeeded: false, user: null }));
  }, [loadAuth]);

  const member = auth.user?.role === 'member';
  useEffect(() => {
    // A family member's login can't see the businesses' lists, so doesn't ask.
    if (auth.user && auth.user.role !== 'member') loadMeta();
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
        {auth.setupNeeded ? (
          <SetupScreen onDone={(user) => setAuth({ loading: false, setupNeeded: false, user })} />
        ) : (
          <SignIn onDone={(user) => setAuth({ loading: false, setupNeeded: false, user })} />
        )}
      </>
    );
  }

  const settings = <Settings user={auth.user} meta={meta} onUserChange={loadAuth} onSignedOut={() => setAuth({ loading: false, setupNeeded: false, user: null })} onMetaChange={loadMeta} />;
  if (member) {
    return (
      <BusinessProvider entities={[]}>
        <Layout username={auth.user.username} member onSignOut={signOut}>
          {error && <Banner>{error}</Banner>}
          <Routes>
            <Route path="/personal" element={<Personal member />} />
            <Route path="/personal/search" element={<PersonalSearch member />} />
            <Route path="/settings" element={settings} />
            <Route path="*" element={<Navigate to="/personal" replace />} />
          </Routes>
        </Layout>
      </BusinessProvider>
    );
  }

  return (
    <BusinessProvider entities={meta?.entities ?? []}>
      <Layout username={auth.user.username} onSignOut={signOut}>
        {error && <Banner>{error}</Banner>}
        <Routes>
          <Route path="/" element={<Dashboard meta={meta} />} />
          <Route path="/transactions" element={<Transactions meta={meta} />} />
          <Route path="/review" element={<Review meta={meta} />} />
          <Route path="/accounts" element={<Accounts meta={meta} />} />
          <Route path="/personal" element={<Personal />} />
          <Route path="/personal/search" element={<PersonalSearch />} />
          <Route path="/wealth" element={<Wealth />} />
          <Route path="/retirement" element={<Retirement />} />
          <Route path="/import" element={<Import />} />
          <Route path="/import/:id" element={<ImportDetail />} />
          <Route path="/more" element={<More />} />
          <Route path="/receipts" element={<Receipts />} />
          <Route path="/receipts/:id" element={<ReceiptDetail meta={meta} />} />
          <Route path="/checks" element={<Receipts kind="check" />} />
          <Route path="/checks/:id" element={<ReceiptDetail meta={meta} kind="check" />} />
          <Route path="/stays" element={<Stays />} />
          <Route path="/stays/:id" element={<StayDetail />} />
          <Route path="/leases" element={<Leases />} />
          <Route path="/hours" element={<Hours />} />
          <Route path="/guests" element={<Guests />} />
          <Route path="/profit-loss" element={<ProfitLoss />} />
          <Route path="/leases/:id" element={<LeaseDetail />} />
          <Route path="/orders" element={<Orders meta={meta} />} />
          <Route path="/items" element={<Items meta={meta} onMetaChange={loadMeta} />} />
          <Route path="/tax" element={<Tax meta={meta} forms={forms} onMetaChange={loadMeta} />} />
          <Route path="/year-end" element={<YearEnd meta={meta} forms={forms} />} />
          <Route path="/settings" element={settings} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BusinessProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

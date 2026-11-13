// The app frame: a sidebar on wide screens, a tab bar along the bottom on phones.
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowLeftRight, BedDouble, FileCheck2, KeyRound, FileSpreadsheet, Inbox, Landmark, LayoutDashboard, LogOut, Menu, Package, Receipt, Settings, Tags, TrendingUp, Upload, Wallet } from 'lucide-react';
import { BusinessPicker, useBusiness } from './business';
import { ExpiryWarning } from './rentroll';
import { cx } from './ui';

// The sidebar order. Phones show the ones marked phone as tabs, the rest under More.
export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, phone: true },
  { to: '/profit-loss', label: 'Profit & loss', icon: TrendingUp },
  { to: '/stays', label: 'Stays', icon: BedDouble, strOnly: true },
  { to: '/leases', label: 'Leases', icon: KeyRound },
  { to: '/accounts', label: 'Accounts', icon: Landmark, divider: true },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, phone: true },
  { to: '/review', label: 'Review', icon: Inbox, phone: true },
  { to: '/receipts', label: 'Receipts', icon: Receipt, phone: true },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/orders', label: 'Orders', icon: Package },
  { to: '/items', label: 'Items', icon: Tags },
  { to: '/tax', label: 'Tax groups', icon: FileSpreadsheet },
  { to: '/year-end', label: 'Year end', icon: FileCheck2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];
type NavEntry = { to: string; label: string; icon: typeof Menu; end?: boolean; phone?: boolean; strOnly?: boolean; divider?: boolean };

// The pages for the business chosen: Stays only for a short-term rental (or all of them).
export function useNav(): NavEntry[] {
  const { current } = useBusiness();
  return (NAV as NavEntry[]).filter((n) => !n.strOnly || !current || current.activity === 'str');
}

// On phones, the pages without a tab of their own are under More.
const PHONE_NAV = [...NAV.filter((n) => n.phone), { to: '/more', label: 'More', icon: Menu, end: false, phone: true }];

export function Layout({ username, onSignOut, children }: { username: string; onSignOut: () => void; children: ReactNode }) {
  const nav = useNav();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      {/* Stays in place while the page scrolls; scrolls itself if the window is short. */}
      <aside className="hidden border-r border-slate-200 bg-slate-900 text-slate-100 md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:self-start md:overflow-y-auto dark:border-slate-800">
        <div className="flex items-center gap-2 px-5 py-5">
          <Wallet className="size-6 text-emerald-400" aria-hidden />
          <span className="text-lg font-semibold tracking-tight">Business Hub</span>
        </div>
        <BusinessPicker className="mx-3 mb-3" />
        <nav aria-label="Main" className="flex-1 space-y-1 px-3">
          {nav.map(({ to, label, icon: Icon, end, divider }) => [
            divider && <hr key={`${to}-divider`} className="!my-3 border-slate-700" aria-hidden />,
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx('flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium', isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white')
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>,
          ])}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4 text-sm">
          <div className="truncate text-slate-400" title={username}>
            Signed in as <span className="text-slate-200">{username}</span>
          </div>
          <button type="button" onClick={onSignOut} className="mt-2 inline-flex items-center gap-2 text-slate-300 hover:text-white">
            <LogOut className="size-4" aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-slate-900 px-4 py-3 text-white md:hidden dark:border-slate-800">
          <span className="flex items-center gap-2 font-semibold">
            <Wallet className="size-5 text-emerald-400" aria-hidden />
            <span className="hidden min-[400px]:inline">Business Hub</span>
          </span>
          <BusinessPicker className="mx-3 min-w-0 flex-1" />
          <button type="button" onClick={onSignOut} className="inline-flex items-center gap-1.5 text-sm text-slate-300" aria-label="Sign out">
            <LogOut className="size-4" aria-hidden />
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 md:px-8 md:pb-10">
          {children}
          <ExpiryWarning />
        </main>
      </div>

      <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-slate-200 bg-white md:hidden dark:border-slate-800 dark:bg-slate-900">
        {PHONE_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => cx('flex flex-col items-center gap-0.5 pt-2 text-[11px] font-medium', isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400')}
          >
            <Icon className="size-5" aria-hidden />
            {label.split(' ')[0]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

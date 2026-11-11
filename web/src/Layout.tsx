// The app frame: a sidebar on wide screens, a tab bar along the bottom on phones.
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowLeftRight, FileSpreadsheet, Inbox, Landmark, LayoutDashboard, LogOut, Menu, Package, Settings, Tags, Upload, Wallet } from 'lucide-react';
import { cx } from './ui';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, phone: true },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, phone: true },
  { to: '/review', label: 'Review', icon: Inbox, phone: true },
  { to: '/accounts', label: 'Accounts', icon: Landmark },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/orders', label: 'Orders', icon: Package, phone: true },
  { to: '/items', label: 'Items', icon: Tags },
  { to: '/tax', label: 'Tax groups', icon: FileSpreadsheet },
  { to: '/settings', label: 'Settings', icon: Settings },
];
// On phones, the pages without a tab of their own are under More.
const PHONE_NAV = [...NAV.filter((n) => n.phone), { to: '/more', label: 'More', icon: Menu, end: false, phone: true }];

export function Layout({ username, onSignOut, children }: { username: string; onSignOut: () => void; children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-slate-200 bg-slate-900 text-slate-100 md:flex md:min-h-dvh md:flex-col dark:border-slate-800">
        <div className="flex items-center gap-2 px-5 py-5">
          <Wallet className="size-6 text-emerald-400" aria-hidden />
          <span className="text-lg font-semibold tracking-tight">Expense Hub</span>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
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
            </NavLink>
          ))}
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
            Expense Hub
          </span>
          <button type="button" onClick={onSignOut} className="inline-flex items-center gap-1.5 text-sm text-slate-300" aria-label="Sign out">
            <LogOut className="size-4" aria-hidden />
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 md:px-8 md:pb-10">{children}</main>
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

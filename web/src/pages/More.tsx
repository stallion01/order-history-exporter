// On phones: the pages that don't have a tab of their own.
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { NAV } from '../Layout';
import { Card, PageHeader } from '../ui';

export function More() {
  return (
    <>
      <PageHeader title="More" />
      <Card padded={false}>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {NAV.filter((n) => !n.phone).map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link to={to} className="flex items-center gap-3 px-4 py-3.5 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800">
                <Icon className="size-5 text-slate-500" aria-hidden />
                <span className="flex-1">{label}</span>
                <ChevronRight className="size-4 text-slate-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

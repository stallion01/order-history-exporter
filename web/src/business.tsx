// Which business the app is showing: one of them, or all together. Chosen once in the
// menu and remembered on this device, so every page agrees.
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Building2 } from 'lucide-react';
import type { Meta } from './filters';
import { cx } from './ui';

export type Entity = Meta['entities'][number];
const KEY = 'hub.business';

export const ACTIVITY_LABELS: Record<string, string> = { str: 'Short-term rental', ltr: 'Long-term rental', other: 'Other business' };
export const TAX_FORM_LABELS: Record<string, string> = {
  'form-1065': 'Form 1065, page 1 (partnership trade or business)',
  'form-8825': 'Form 8825 (partnership rental real estate)',
  'schedule-c': 'Schedule C (sole owner, business)',
  'schedule-e': 'Schedule E (sole owner, rental)',
};

const Context = createContext<{ business: number | null; setBusiness: (id: number | null) => void; entities: Entity[]; current: Entity | null }>({
  business: null,
  setBusiness: () => {},
  entities: [],
  current: null,
});

const read = () => {
  try {
    const value = localStorage.getItem(KEY);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
};

export function BusinessProvider({ entities, children }: { entities: Entity[]; children: ReactNode }) {
  const [chosen, setChosen] = useState<number | null>(read);
  // A business that no longer exists falls back to all of them.
  const business = chosen !== null && entities.some((e) => e.id === chosen) ? chosen : null;
  useEffect(() => {
    if (chosen !== null && entities.length && !entities.some((e) => e.id === chosen)) setChosen(null);
  }, [chosen, entities]);
  const setBusiness = (id: number | null) => {
    setChosen(id);
    try {
      if (id === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(id));
    } catch {
      // Not remembered on this device; still chosen for now.
    }
  };
  return <Context.Provider value={{ business, setBusiness, entities, current: entities.find((e) => e.id === business) ?? null }}>{children}</Context.Provider>;
}

export const useBusiness = () => useContext(Context);

// The choice in the menu. Hidden until there's a business to choose.
export function BusinessPicker({ className }: { className?: string }) {
  const { business, setBusiness, entities } = useBusiness();
  if (!entities.length) return null;
  return (
    <label className={cx('flex items-center gap-2 text-sm', className)}>
      <Building2 className="size-4 shrink-0 text-emerald-400" aria-hidden />
      <span className="sr-only">Business</span>
      <select
        value={business ?? ''}
        onChange={(e) => setBusiness(e.target.value ? Number(e.target.value) : null)}
        className="min-w-0 flex-1 truncate rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white focus:outline-2 focus:outline-emerald-500"
      >
        <option value="">All businesses</option>
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// The query parameter for the chosen business, for API calls.
export const businessQuery = (business: number | null) => (business ? `&entity=${business}` : '');

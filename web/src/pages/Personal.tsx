// The owner's own money: what came in, where it went, budgets for each kind of
// spending, and a look back over the past year and ahead over the next six months.
import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Search,
  ArrowLeftRight,
  Banknote,
  Briefcase,
  CalendarClock,
  Car,
  Check,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  HandHeart,
  HeartHandshake,
  HandCoins,
  HeartPulse,
  House,
  Landmark,
  Pencil,
  PiggyBank,
  Plane,
  ReceiptText,
  Repeat,
  Shapes,
  ShoppingBag,
  Sparkles,
  Store,
  TrendingUp,
  Undo2,
  Users,
  UtensilsCrossed,
  X,
  Zap,
} from 'lucide-react';
import { post, useApi } from '../api';
import { BankBadge } from '../banks';
import { MONTHS, money, plural, wholeMoney } from '../format';
import { Banner, Button, Card, Input, Loading, cx } from '../ui';

type Icon = typeof House;
interface GroupInfo {
  label: string;
  colour: string;
  icon: Icon;
}

// Each kind of money, with a colour that reads in light and dark mode.
const GROUPS: Record<string, GroupInfo> = {
  home: { label: 'Home', colour: '#6366f1', icon: House },
  bills: { label: 'Bills & utilities', colour: '#0ea5e9', icon: Zap },
  food: { label: 'Food & dining', colour: '#f59e0b', icon: UtensilsCrossed },
  car: { label: 'Car & getting around', colour: '#ef4444', icon: Car },
  shopping: { label: 'Shopping', colour: '#ec4899', icon: ShoppingBag },
  health: { label: 'Health & insurance', colour: '#10b981', icon: HeartPulse },
  education: { label: 'Education & kids', colour: '#8b5cf6', icon: GraduationCap },
  travel: { label: 'Travel & fun', colour: '#14b8a6', icon: Plane },
  subscriptions: { label: 'Subscriptions', colour: '#d946ef', icon: Repeat },
  people: { label: 'Sent to people', colour: '#f97316', icon: Users },
  family: { label: 'Sent to family', colour: '#e11d48', icon: HeartHandshake },
  taxes: { label: 'Taxes & fees', colour: '#64748b', icon: Landmark },
  cash: { label: 'Cash & checks', colour: '#84cc16', icon: Banknote },
  other: { label: 'Not sorted yet', colour: '#94a3b8', icon: Shapes },
  pay: { label: 'Paychecks', colour: '#10b981', icon: Briefcase },
  reimbursed: { label: 'Reimbursements', colour: '#06b6d4', icon: ReceiptText },
  refunds: { label: 'Refunds & tax refunds', colour: '#22c55e', icon: Undo2 },
  people_in: { label: 'From people', colour: '#f59e0b', icon: HandCoins },
  family_in: { label: 'From family', colour: '#f472b6', icon: HandHeart },
  side: { label: 'Rent & side income', colour: '#8b5cf6', icon: Store },
  deposits: { label: 'Deposits', colour: '#3b82f6', icon: Banknote },
  other_in: { label: 'Other money in', colour: '#94a3b8', icon: Shapes },
  invested: { label: 'Saved & invested', colour: '#6366f1', icon: PiggyBank },
  from_savings: { label: 'Taken from savings', colour: '#a5b4fc', icon: TrendingUp },
  business: { label: 'Your businesses', colour: '#0ea5e9', icon: Store },
  between: { label: 'Between your accounts', colour: '#94a3b8', icon: ArrowLeftRight },
};
// The kinds of spending, in order, for choosing what a family category counts as.
const SPENDING_KEYS = ['home', 'bills', 'food', 'car', 'shopping', 'health', 'education', 'travel', 'subscriptions', 'people', 'family', 'taxes', 'cash', 'other'];
// The person's own names for the groups, from what's on screen.
let NAMES: Record<string, string> = {};
export const setGroupNames = (names: Record<string, string> | undefined) => {
  NAMES = names ?? {};
};
const usual = (key: string): GroupInfo => GROUPS[key] ?? { label: key, colour: '#94a3b8', icon: Shapes };
export const info = (key: string): GroupInfo => (NAMES[key] ? { ...usual(key), label: NAMES[key] } : usual(key));

interface MonthRow {
  month: string;
  earned: number;
  spent: number;
  kept: number;
  invested: number;
  business: number;
  future: boolean;
  current: boolean;
  noData: boolean;
  projectedEarned: number | null;
  projectedSpent: number | null;
  cumulative: number;
}
interface TxRow {
  id: number;
  posted: string;
  amount: number;
  name: string;
  description: string;
  account: string;
  guessed: boolean;
  category: string | null;
}
interface GroupRow {
  key: string;
  amount: number;
  projected: number;
  budget: number | null;
  typical: number;
  typicalSoFar: number | null;
  count: number;
  merchants: { name: string; amount: number; count: number }[];
  transactions: TxRow[];
}
interface PersonalData {
  today: string;
  thisMonth: string;
  period: 'month' | 'year';
  month: string;
  year: string;
  span: { from: string; to: string };
  future: boolean;
  current: boolean;
  person: { id: number; name: string } | null;
  people: { id: number; name: string }[];
  firstMonth: string;
  accounts: { id: number; name: string; institution: string | null; kind: string; balance: number | null; balanceDate: string | null; transactions: number }[];
  selectedAccounts: number[];
  budgets: Record<string, number>;
  groupNames: Record<string, string>;
  groupRules: { id: number; name: string; group: string }[];
  typical: Record<string, number>;
  months: MonthRow[];
  detail: {
    month: string;
    earned: number;
    spent: number;
    kept: number;
    rate: number | null;
    outlook: { earned: number; spent: number } | null;
    groups: GroupRow[];
    sources: { key: string; amount: number; count: number; payers: { name: string; amount: number; count: number }[] }[];
    moves: { key: string; amount: number }[];
    pace: { unit: 'day' | 'month'; days: number; actual: number[]; typical: number[]; budget: number | null };
    biggest: { id: number; posted: string; amount: number; name: string; group: string; account: string }[];
    unsorted: number;
    unsortedIds: number[];
  };
  recurring: { key: string; name: string; flow: string; group: string; amount: number; day: number; months: number; paidThisMonth: boolean }[];
  upcoming: { name: string; flow: string; group: string; amount: number; on: string }[];
  familyLabels: { id: number; name: string; group: string }[];
  family: { id: number; posted: string; amount: number; name: string; account: string; labelId: number | null; label: string | null; group: string }[];
  last12: { from: string; to: string; spent: { key: string; amount: number }[]; earned: { key: string; amount: number }[] };
}

const monthName = (m: string, short = false) => {
  const [y, mm] = m.split('-').map(Number);
  return short ? MONTHS[mm - 1] : `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mm - 1]} ${y}`;
};
const shiftMonth = (m: string, n: number) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1 + n, 1)).toISOString().slice(0, 7);
};
const short = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}k` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${Math.round(a)}`;
  return `${n < 0 ? '−' : ''}$${s}`;
};
const dayLabel = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
// "November 2026", or "2026" for a year.
const spanName = (data: PersonalData, short = false) => (data.period === 'year' ? data.year : monthName(data.month, short));

// Who is looking: the owner can see anyone's money and change budgets; a family
// member's login sees only their own, and can set its budgets and sort its payments.
export function Personal({ member = false }: { member?: boolean }) {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams();
  for (const key of ['month', 'year', 'accounts', 'person']) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const { data, error, loading, reload } = useApi<PersonalData>(`/api/personal${query.size ? `?${query}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);

  const change = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setOpen(null);
    setParams(next, { replace: true });
  };
  // A month, or a whole year.
  const pick = (m: string) => change({ month: data && m === data.thisMonth ? null : m, year: null });
  const pickYear = (y: string) => change({ year: y, month: null });
  const chosen = (params.get('accounts') || '').split(',').filter(Boolean).map(Number);
  const toggleAccount = (id: number) => {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    change({ accounts: next.length ? next.join(',') : null });
  };

  if (error) return <Banner>{error.message}</Banner>;
  if (!data) return loading ? <Loading /> : null;
  const d = data.detail;
  setGroupNames(data.groupNames);

  return (
    <>
      <Hero
        data={data}
        member={member}
        onPick={pick}
        onPickYear={pickYear}
        onPerson={(id) => change({ person: id === null ? null : String(id), accounts: null })}
        chosen={chosen}
        onToggle={toggleAccount}
        onAll={() => change({ accounts: null })}
      />
      {d.unsorted > 0 && !data.future && (
        <Banner tone="info">
          {plural(d.unsorted, 'payment')} in {spanName(data)} couldn't be sorted from the bank's description.{' '}
          {member ? (
            <>Open Not sorted yet under Where it went and pick a group for each; it can go for every payment from the same place.</>
          ) : (
            <>
              <Link className="font-medium underline" to={`/transactions?preset=all&kind=all&${d.unsortedIds.map((id) => `id=${id}`).join('&')}`}>
                Give them a category
              </Link>{' '}
              and they'll land in the right group.
            </>
          )}
        </Banner>
      )}
      <Timeline months={data.months} span={data.span} today={data.today} onPick={pick} />
      <div className="mb-5 grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <WhereItWent data={data} open={open} onOpen={setOpen} member={member} onChange={reload} />
        <div className="grid content-start gap-5">
          <WhereItCame data={data} />
          <Moved data={data} />
        </div>
      </div>
      {data.family.length > 0 && <BetweenFamily data={data} onChange={reload} readOnly={member} />}
      <Budgets data={data} onChange={reload} readOnly={false} />
      <YourGroups data={data} onChange={reload} />
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Pace data={data} />
        <ComingUp data={data} />
      </div>
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Biggest data={data} member={member} />
        <YourYear data={data} />
      </div>
    </>
  );
}

/* ---------- The top: whose money, which month or year, and what was kept ---------- */

function Hero({
  data,
  member,
  onPick,
  onPickYear,
  onPerson,
  chosen,
  onToggle,
  onAll,
}: {
  data: PersonalData;
  member: boolean;
  onPick: (m: string) => void;
  onPickYear: (y: string) => void;
  onPerson: (id: number | null) => void;
  chosen: number[];
  onToggle: (id: number) => void;
  onAll: () => void;
}) {
  const d = data.detail;
  const forecast = data.future;
  const yearly = data.period === 'year';
  const current = data.current;
  const thisYear = data.thisMonth.slice(0, 4);
  const kept = d.kept;
  const outlook = d.outlook ? d.outlook.earned - d.outlook.spent : null;
  const step = (n: number) => (yearly ? onPickYear(String(Number(data.year) + n)) : onPick(shiftMonth(data.month, n)));
  const whose = !member && data.person ? `${data.person.name}'s money` : 'My money';
  return (
    <section className="relative mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-teal-700 to-indigo-800 p-5 text-white shadow-lg sm:p-7">
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-white/10 blur-2xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/3 size-72 rounded-full bg-emerald-300/20 blur-3xl" />
      {!member && data.people.length > 0 && (
        <div className="relative mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Whose money">
          <Users className="mr-1 size-4 text-emerald-100" aria-hidden />
          <Chip active={data.person === null} onClick={() => onPerson(null)}>
            Me
          </Chip>
          {data.people.map((p) => (
            <Chip key={p.id} active={data.person?.id === p.id} onClick={() => onPerson(p.id)}>
              {p.name}
            </Chip>
          ))}
          <Link to="/settings#family" className="ml-1 text-xs text-emerald-100 underline-offset-2 hover:underline">
            Manage
          </Link>
        </div>
      )}
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium tracking-wide text-emerald-100 uppercase">{whose}</p>
            <Link
              to={`/personal/search${!member && data.person ? `?person=${data.person.id}` : ''}`}
              className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/25"
            >
              <Search className="size-3.5" aria-hidden /> Search
            </Link>
            <div className="inline-flex rounded-full bg-white/10 p-0.5 text-xs font-medium" role="group" aria-label="Month or year">
              <button
                type="button"
                aria-pressed={!yearly}
                onClick={() => !yearly || onPick(current ? data.thisMonth : `${data.year}-${data.thisMonth.slice(5)}`)}
                className={cx('rounded-full px-3 py-1', !yearly ? 'bg-white text-teal-800 shadow' : 'hover:bg-white/15')}
              >
                Month
              </button>
              <button
                type="button"
                aria-pressed={yearly}
                onClick={() => yearly || onPickYear(data.month.slice(0, 4))}
                className={cx('rounded-full px-3 py-1', yearly ? 'bg-white text-teal-800 shadow' : 'hover:bg-white/15')}
              >
                Year
              </button>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" aria-label={yearly ? 'Year before' : 'Month before'} onClick={() => step(-1)} className="rounded-full p-1.5 hover:bg-white/15">
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <h1 className={cx('text-center text-2xl font-semibold tracking-tight sm:text-3xl', yearly ? 'min-w-[5ch]' : 'min-w-[11ch]')}>{spanName(data)}</h1>
            <button type="button" aria-label={yearly ? 'Year after' : 'Month after'} onClick={() => step(1)} className="rounded-full p-1.5 hover:bg-white/15">
              <ChevronRight className="size-5" aria-hidden />
            </button>
            {!(yearly && current) && (
              <button type="button" onClick={() => onPickYear(thisYear)} className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium hover:bg-white/25">
                This year
              </button>
            )}
            {!(!yearly && current) && (
              <button type="button" onClick={() => onPick(data.thisMonth)} className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium hover:bg-white/25">
                This month
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-emerald-50/90">
            {forecast
              ? 'A forecast from regular paychecks and bills, and budgets or typical months.'
              : current
                ? `So far this ${yearly ? 'year' : 'month'}, to ${dayLabel(data.today)}.`
                : 'Personal accounts, without transfers between them.'}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap gap-1.5" role="group" aria-label="Accounts included">
          <Chip active={!chosen.length} onClick={onAll}>
            All accounts
          </Chip>
          {data.accounts.map((a) => (
            <Chip key={a.id} active={chosen.includes(a.id)} onClick={() => onToggle(a.id)} title={a.balance !== null ? `Balance ${money(a.balance)}` : undefined}>
              <BankBadge institution={a.institution} accountName={a.name} className="!size-4 !text-[7px]" />
              <span className="max-w-[14ch] truncate">{a.name}</span>
            </Chip>
          ))}
        </div>
      </div>

      {!data.accounts.length ? (
        <p className="relative mt-6 rounded-xl bg-white/10 px-4 py-3 text-sm">
          No accounts here yet.{' '}
          {!member && (
            <Link to="/settings#family" className="font-medium underline">
              Choose {data.person ? `${data.person.name}'s` : 'whose'} accounts in Settings
            </Link>
          )}
        </p>
      ) : (
        <div className="relative mt-6 grid items-center gap-6 sm:grid-cols-[auto_1fr]">
          <Ring rate={d.rate} />
          <div>
            <p className="text-sm text-emerald-50/90">{forecast ? 'Could keep' : kept >= 0 ? 'Kept' : 'Spent more than came in, by'}</p>
            <p className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">{wholeMoney(Math.abs(kept))}</p>
            {current && outlook !== null && (
              <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm">
                <TrendingUp className="size-4" aria-hidden />
                {outlook >= 0
                  ? `On track to keep ${wholeMoney(outlook)} by the end of ${yearly ? data.year : monthName(data.month, true)}`
                  : `On track to spend ${wholeMoney(-outlook)} more than comes in`}
              </p>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <HeroStat label={forecast ? 'Expected in' : 'Money in'} value={d.earned} tone="in" />
              <HeroStat label={forecast ? 'Expected out' : 'Money out'} value={d.spent} tone="out" />
              <HeroStat label="Moved to savings & businesses" value={-d.moves.filter((m) => m.key === 'invested' || m.key === 'business').reduce((s, m) => s + m.amount, 0)} tone="move" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition', active ? 'bg-white text-teal-800 shadow' : 'bg-white/10 text-white hover:bg-white/20')}
    >
      {children}
    </button>
  );
}

function HeroStat({ label, value, tone }: { label: string; value: number; tone: 'in' | 'out' | 'move' }) {
  const dot = tone === 'in' ? 'bg-emerald-300' : tone === 'out' ? 'bg-rose-300' : 'bg-indigo-200';
  return (
    <div className="rounded-xl bg-white/10 px-3 py-2 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 text-xs text-emerald-50/90">
        <span className={cx('size-2 rounded-full', dot)} aria-hidden />
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{wholeMoney(Math.max(0, value))}</div>
    </div>
  );
}

// How much of what came in was kept, as a ring.
function Ring({ rate }: { rate: number | null }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const part = rate === null ? 0 : Math.max(0, Math.min(100, rate)) / 100;
  return (
    <div className="relative mx-auto size-32 sm:mx-0">
      <svg viewBox="0 0 120 120" className="size-32 -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="12" />
        <circle cx="60" cy="60" r={r} fill="none" stroke="#6ee7b7" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${c * part} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-2xl font-bold tabular-nums">{rate === null ? '–' : `${Math.round(rate)}%`}</span>
        <span className="text-[11px] leading-tight text-emerald-50/90">
          of money in
          <br />
          kept
        </span>
      </div>
    </div>
  );
}

/* ---------- Month by month, back and ahead ---------- */

function Timeline({ months, span, today, onPick }: { months: MonthRow[]; span: { from: string; to: string }; today: string; onPick: (m: string) => void }) {
  const inSpan = (m: string) => m >= span.from && m <= span.to;
  const W = 56;
  const H = 210;
  const top = 18;
  const bottom = 34;
  const values = months.flatMap((m) => [m.future ? (m.projectedEarned ?? 0) : m.earned, m.future ? (m.projectedSpent ?? 0) : Math.max(m.spent, m.projectedSpent ?? 0)]);
  const max = Math.max(1, ...values);
  const y = (v: number) => top + (H - top - bottom) * (1 - Math.max(0, v) / max);
  const base = y(0);
  const width = months.length * W;
  const keptPoints = months.map((m, i) => {
    // The month under way is plotted where it's heading, like the months after it.
    const k = m.future || m.current ? (m.projectedEarned ?? 0) - (m.projectedSpent ?? 0) : m.kept;
    return [i * W + W / 2, y(Math.max(0, k))] as const;
  });
  const todayIndex = months.findIndex((m) => m.current);
  return (
    <Card
      title="Month by month"
      className="mb-5"
      actions={
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
          <Legend colour="#10b981">Money in</Legend>
          <Legend colour="#f43f5e">Money out</Legend>
          <Legend colour="#6366f1" line>
            Kept
          </Legend>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm border border-slate-400 bg-[repeating-linear-gradient(45deg,#94a3b8_0_2px,transparent_2px_4px)]" aria-hidden />
            Forecast
          </span>
        </div>
      }
    >
      <div className="-mx-1 overflow-x-auto pb-1">
        <svg
          viewBox={`0 0 ${width} ${H}`}
          style={{ minWidth: Math.max(width * 0.62, 320) }}
          className="block h-56 w-full"
          role="img"
          aria-label="Money in and out for each month, with the months ahead forecast"
        >
          <defs>
            <pattern id="hatch-in" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#10b981" opacity="0.18" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="#10b981" strokeWidth="2.2" />
            </pattern>
            <pattern id="hatch-out" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#f43f5e" opacity="0.18" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="#f43f5e" strokeWidth="2.2" />
            </pattern>
            <linearGradient id="kept-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#6366f1" stopOpacity="0.25" />
              <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
            </linearGradient>
          </defs>
          {todayIndex >= 0 && <rect x={(todayIndex + 1) * W} y={0} width={width - (todayIndex + 1) * W} height={H - bottom + 4} className="fill-slate-100 dark:fill-slate-800/60" />}
          <line x1={0} x2={width} y1={base} y2={base} className="stroke-slate-300 dark:stroke-slate-700" />
          {months.map((m, i) => {
            const x = i * W;
            const isSel = inSpan(m.month);
            const earned = m.future ? (m.projectedEarned ?? 0) : m.earned;
            const spent = m.future ? (m.projectedSpent ?? 0) : m.spent;
            const bw = 17;
            return (
              <g key={m.month} className="cursor-pointer" onClick={() => onPick(m.month)}>
                <title>{`${monthName(m.month)}${m.future ? ' (forecast)' : m.current ? ' (so far)' : ''}: in ${money(earned)}, out ${money(spent)}`}</title>
                <rect
                  x={x + 2}
                  y={4}
                  width={W - 4}
                  height={H - 8}
                  rx={8}
                  className={isSel ? 'fill-teal-500/15 stroke-teal-500' : 'fill-transparent hover:fill-slate-400/10'}
                  strokeWidth={isSel ? 1.5 : 0}
                />
                {!m.noData && (
                  <>
                    <rect x={x + W / 2 - bw - 1.5} y={y(earned)} width={bw} height={Math.max(0, base - y(earned))} rx={3} fill={m.future ? 'url(#hatch-in)' : '#10b981'} />
                    <rect x={x + W / 2 + 1.5} y={y(spent)} width={bw} height={Math.max(0, base - y(spent))} rx={3} fill={m.future ? 'url(#hatch-out)' : '#f43f5e'} />
                    {m.current && m.projectedSpent !== null && m.projectedSpent > spent && (
                      <rect x={x + W / 2 + 1.5} y={y(m.projectedSpent)} width={bw} height={Math.max(0, y(spent) - y(m.projectedSpent))} rx={3} fill="url(#hatch-out)" />
                    )}
                    {m.current && m.projectedEarned !== null && m.projectedEarned > earned && (
                      <rect x={x + W / 2 - bw - 1.5} y={y(m.projectedEarned)} width={bw} height={Math.max(0, y(earned) - y(m.projectedEarned))} rx={3} fill="url(#hatch-in)" />
                    )}
                  </>
                )}
                <text
                  x={x + W / 2}
                  y={H - bottom + 17}
                  textAnchor="middle"
                  className={cx('text-[11px]', isSel ? 'fill-teal-700 font-semibold dark:fill-teal-300' : 'fill-slate-500 dark:fill-slate-400')}
                >
                  {monthName(m.month, true)}
                </text>
                {(m.month.endsWith('-01') || i === 0) && (
                  <text x={x + W / 2} y={H - bottom + 30} textAnchor="middle" className="fill-slate-400 text-[10px]">
                    {m.month.slice(0, 4)}
                  </text>
                )}
              </g>
            );
          })}
          <path d={`M${keptPoints.map((p) => p.join(',')).join(' L')} L${keptPoints[keptPoints.length - 1][0]},${base} L${keptPoints[0][0]},${base} Z`} fill="url(#kept-fill)" pointerEvents="none" />
          <polyline points={keptPoints.map((p) => p.join(',')).join(' ')} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round" pointerEvents="none" />
          {keptPoints.map(([px, py], i) => (
            <circle
              key={i}
              cx={px}
              cy={py}
              r={inSpan(months[i].month) ? 4.5 : 3}
              fill={months[i].future || months[i].current ? 'white' : '#6366f1'}
              stroke="#6366f1"
              strokeWidth="2"
              pointerEvents="none"
            />
          ))}
          {todayIndex >= 0 && (
            <text x={(todayIndex + 1) * W + 6} y={14} className="fill-slate-500 text-[10px] font-medium dark:fill-slate-400">
              Ahead →
            </text>
          )}
        </svg>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Tap a month to see it below. Months ahead use your regular paychecks and bills, and your budgets (or a typical month) for everything else. Today is {dayLabel(today)}.
      </p>
    </Card>
  );
}

function Legend({ colour, line, children }: { colour: string; line?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={line ? 'h-0.5 w-3.5 rounded' : 'size-2.5 rounded-sm'} style={{ background: colour }} aria-hidden />
      {children}
    </span>
  );
}

/* ---------- Where it went ---------- */

function WhereItWent({ data, open, onOpen, member, onChange }: { data: PersonalData; open: string | null; onOpen: (g: string | null) => void; member: boolean; onChange: () => void }) {
  const groups = data.detail.groups.filter((g) => g.amount > 0.5).sort((a, b) => b.amount - a.amount);
  const total = groups.reduce((s, g) => s + g.amount, 0);
  const selected = groups.find((g) => g.key === open) ?? null;
  return (
    <Card title={data.future ? 'Where it should go' : 'Where it went'}>
      {!groups.length ? (
        <p className="py-8 text-center text-sm text-slate-500">No spending {data.future ? 'expected' : 'this month'}.</p>
      ) : (
        <div className="grid items-start gap-5 sm:grid-cols-[13rem_1fr]">
          <Donut slices={groups.map((g) => ({ key: g.key, value: g.amount }))} total={total} active={open} onPick={(k) => onOpen(k === open ? null : k)} label={data.future ? 'expected' : 'spent'} />
          <ul className="space-y-1">
            {groups.map((g) => {
              const gi = info(g.key);
              const I = gi.icon;
              const pct = total ? (g.amount / total) * 100 : 0;
              return (
                <li key={g.key}>
                  <button
                    type="button"
                    onClick={() => onOpen(g.key === open ? null : g.key)}
                    aria-expanded={g.key === open}
                    className={cx('w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60', g.key === open && 'bg-slate-100 dark:bg-slate-800')}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="flex size-6 items-center justify-center rounded-md" style={{ background: `${gi.colour}22`, color: gi.colour }}>
                        <I className="size-3.5" aria-hidden />
                      </span>
                      <span className="flex-1 truncate font-medium">{gi.label}</span>
                      <span className="tabular-nums">{wholeMoney(g.amount)}</span>
                      <span className="w-10 text-right text-xs text-slate-500 tabular-nums">{Math.round(pct)}%</span>
                    </div>
                    <div className="mt-1 ml-8 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: gi.colour }} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {selected && <GroupDetail group={selected} future={data.future} member={member} onChange={onChange} onClose={() => onOpen(null)} />}
    </Card>
  );
}

function Donut({ slices, total, active, onPick, label }: { slices: { key: string; value: number }[]; total: number; active: string | null; onPick: (k: string) => void; label: string }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative mx-auto size-52">
      <svg viewBox="0 0 200 200" className="size-52 -rotate-90" role="img" aria-label={`Spending by kind, ${wholeMoney(total)} in all`}>
        <circle cx="100" cy="100" r={r} fill="none" className="stroke-slate-100 dark:stroke-slate-800" strokeWidth="26" />
        {slices.map((s) => {
          const len = total ? (s.value / total) * c : 0;
          const gap = slices.length > 1 ? Math.min(2.5, len / 3) : 0;
          const el = (
            <circle
              key={s.key}
              cx="100"
              cy="100"
              r={r}
              fill="none"
              stroke={info(s.key).colour}
              strokeWidth={active === s.key ? 34 : 26}
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
              strokeDashoffset={-offset}
              opacity={active && active !== s.key ? 0.35 : 1}
              className="cursor-pointer transition-all"
              onClick={() => onPick(s.key)}
            >
              <title>{`${info(s.key).label}: ${wholeMoney(s.value)}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
        <span className="text-xl font-bold tabular-nums">{wholeMoney(total)}</span>
      </div>
    </div>
  );
}

// The kinds of spending a payment can be moved to. Sent to family is only for transfers.
const MOVE_TO = SPENDING_KEYS.filter((k) => k !== 'family');

function GroupDetail({ group, future, member, onChange, onClose }: { group: GroupRow; future: boolean; member: boolean; onChange: () => void; onClose: () => void }) {
  const gi = info(group.key);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [everyTime, setEveryTime] = useState(true);
  // A family login sorts its own payments here; the owner gives a category in Transactions.
  const move = async (id: number, to: string) => {
    setBusy(id);
    setError(null);
    try {
      await post('/api/personal/group', { transactionId: id, group: to, everyTime });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-5 rounded-xl border p-4" style={{ borderColor: `${gi.colour}66`, background: `${gi.colour}0d` }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{gi.label}</h3>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-700" aria-label="Close">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {future ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{group.budget !== null ? `The budget: ${wholeMoney(group.budget)}.` : `Typical: ${wholeMoney(group.typical)}.`}</p>
      ) : (
        <>
          {group.merchants.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {group.merchants.map((m) => {
                const chip = (
                  <>
                    <span className="font-medium">{m.name}</span> <span className="text-slate-500 tabular-nums">{wholeMoney(m.amount)}</span>
                    {m.count > 1 && <span className="text-slate-400"> ×{m.count}</span>}
                  </>
                );
                const chipClass = 'rounded-full bg-white px-2.5 py-1 text-xs shadow-sm dark:bg-slate-900';
                // For the owner, a payee opens its payments here in Transactions, to give them a category.
                const ids = group.transactions
                  .filter((t) => t.name.toLowerCase() === m.name.toLowerCase())
                  .map((t) => t.id)
                  .slice(0, 100);
                return member || !ids.length ? (
                  <span key={m.name} className={chipClass}>
                    {chip}
                  </span>
                ) : (
                  <Link key={m.name} to={`/transactions?preset=all&kind=all&${ids.map((id) => `id=${id}`).join('&')}`} className={cx(chipClass, 'hover:ring-1 hover:ring-slate-300')}>
                    {chip}
                  </Link>
                );
              })}
            </div>
          )}
          {error && <Banner>{error}</Banner>}
          {member && (
            <label className="mb-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={everyTime} onChange={(e) => setEveryTime(e.target.checked)} className="size-4" />
              Moving one moves every payment from the same place, now and later
            </label>
          )}
          <ul className="max-h-96 divide-y divide-slate-200/70 overflow-y-auto text-sm dark:divide-slate-700/70">
            {group.transactions.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-1.5">
                <span className="w-12 shrink-0 text-xs text-slate-500">{dayLabel(t.posted)}</span>
                <TxName id={t.id} member={member} className="min-w-0 flex-1 truncate" title={t.description}>
                  {t.name}
                  <span className="ml-1.5 text-xs text-slate-400">{t.account}</span>
                </TxName>
                <span className={cx('tabular-nums', t.amount > 0 && 'text-emerald-600')}>{money(-t.amount)}</span>
                {member && (
                  <select
                    aria-label={`Move ${t.name} to`}
                    value={group.key}
                    disabled={busy === t.id}
                    onChange={(e) => move(t.id, e.target.value)}
                    className="w-28 shrink-0 rounded-md border border-slate-300 bg-white px-1.5 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900"
                  >
                    {!MOVE_TO.includes(group.key) && <option value={group.key}>{gi.label}</option>}
                    {MOVE_TO.map((k) => (
                      <option key={k} value={k}>
                        {info(k).label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {member ? 'Something in the wrong group? Pick the right one beside it.' : 'Something in the wrong group? Open it and give it a category; the group follows the category.'}
          </p>
        </>
      )}
    </div>
  );
}

// A transaction's name: a link to it for the owner, plain text for a family login.
function TxName({ id, member, className, title, children }: { id: number; member: boolean; className: string; title?: string; children: ReactNode }) {
  if (member)
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  return (
    <Link to={`/transactions?id=${id}&preset=all&kind=all`} className={cx(className, 'hover:underline')} title={title}>
      {children}
    </Link>
  );
}

/* ---------- Your groups ---------- */

// Each person's own names for the kinds of spending, and the places they've put in one
// group for good.
function YourGroups({ data, onChange }: { data: PersonalData; onChange: () => void }) {
  const person = data.person?.id ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(null);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (group: string, value: string | null) =>
    run(() => post('/api/personal/names', { group, name: value && value.trim() && value.trim() !== usual(group).label ? value.trim() : null, person }));
  return (
    <Card title="Your groups" className="mb-5">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Rename any group to suit you. Places you've put in a group for good are listed below it.</p>
      {error && <Banner>{error}</Banner>}
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {MOVE_TO.map((key) => {
          const gi = info(key);
          const I = gi.icon;
          const places = data.groupRules.filter((r) => r.group === key);
          return (
            <li key={key} className="py-2">
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md" style={{ background: `${gi.colour}22`, color: gi.colour }}>
                  <I className="size-4" aria-hidden />
                </span>
                {editing === key ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      save(key, name);
                    }}
                  >
                    <Input value={name} maxLength={40} autoFocus aria-label={`New name for ${gi.label}`} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" />
                    <Button type="submit" disabled={busy}>
                      Save
                    </Button>
                    <button type="button" className="text-xs text-slate-500" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 font-medium">
                      {gi.label}
                      {data.groupNames[key] && <span className="ml-1.5 text-xs font-normal text-slate-400">was {usual(key).label}</span>}
                    </span>
                    {data.groupNames[key] && (
                      <button type="button" className="text-xs text-slate-500 hover:underline" disabled={busy} onClick={() => save(key, null)}>
                        Undo
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded-md px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                      onClick={() => {
                        setEditing(key);
                        setName(gi.label);
                      }}
                    >
                      Rename
                    </button>
                  </>
                )}
              </div>
              {places.length > 0 && (
                <div className="mt-1.5 ml-9 flex flex-wrap gap-1.5">
                  {places.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-xs dark:bg-slate-800">
                      {p.name}
                      <button
                        type="button"
                        aria-label={`Stop putting ${p.name} in ${gi.label}`}
                        disabled={busy}
                        onClick={() => run(() => post(`/api/personal/rules/${p.id}/delete`, { person }))}
                        className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---------- Where it came from ---------- */

function WhereItCame({ data }: { data: PersonalData }) {
  const sources = data.detail.sources.filter((s) => s.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = sources.reduce((s, x) => s + x.amount, 0);
  return (
    <Card title={data.future ? 'Where it should come from' : 'Where it came from'}>
      {!sources.length ? (
        <p className="py-4 text-center text-sm text-slate-500">Nothing {data.future ? 'regular expected' : 'came in'}.</p>
      ) : (
        <>
          <div className="mb-3 flex h-4 overflow-hidden rounded-full" role="img" aria-label="Money in by source">
            {sources.map((s) => (
              <div key={s.key} style={{ width: `${(s.amount / total) * 100}%`, background: info(s.key).colour }} title={`${info(s.key).label}: ${wholeMoney(s.amount)}`} />
            ))}
          </div>
          <ul className="space-y-2 text-sm">
            {sources.map((s) => {
              const gi = info(s.key);
              const I = gi.icon;
              return (
                <li key={s.key}>
                  <div className="flex items-center gap-2">
                    <I className="size-4" style={{ color: gi.colour }} aria-hidden />
                    <span className="flex-1 font-medium">{gi.label}</span>
                    <span className="tabular-nums">{wholeMoney(s.amount)}</span>
                  </div>
                  {s.payers.length > 0 && <div className="ml-6 truncate text-xs text-slate-500 dark:text-slate-400">{s.payers.map((p) => `${p.name} ${short(p.amount)}`).join(' · ')}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

function Moved({ data }: { data: PersonalData }) {
  const moves = data.detail.moves;
  if (!moves.length) return null;
  return (
    <Card title="Moved, not spent">
      <ul className="space-y-2 text-sm">
        {moves.map((m) => {
          const gi = info(m.key);
          const I = gi.icon;
          return (
            <li key={m.key} className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md" style={{ background: `${gi.colour}22`, color: gi.colour }}>
                <I className="size-3.5" aria-hidden />
              </span>
              <span className="flex-1">{gi.label}</span>
              <span className="tabular-nums">{m.amount < 0 ? `${wholeMoney(-m.amount)} out` : `${wholeMoney(m.amount)} in`}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Savings, investments, your businesses and your own accounts: not counted as money in or out.</p>
    </Card>
  );
}

/* ---------- Between family ---------- */

// Money sent to and from other family members, each with a category of the owner's
// own: "Monthly allowance", "University fees". The category decides which kind of
// spending it counts as for the one who sent it, and goes on both sides.
const NEW_LABEL = 'new';
function BetweenFamily({ data, onChange, readOnly }: { data: PersonalData; onChange: () => void; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', group: 'family' });
  const rows = data.family;
  const sent = -rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
  const received = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const choose = (id: number, value: string) => {
    if (value === NEW_LABEL) {
      setAdding(id);
      return;
    }
    run(() => post('/api/personal/family', { transactionId: id, labelId: value ? Number(value) : null }));
  };
  async function addLabel(event: FormEvent) {
    event.preventDefault();
    const id = adding!;
    const ok = await run(async () => {
      const { id: labelId } = await post<{ id: number }>('/api/personal/labels', { name: form.name.trim(), group: form.group });
      await post('/api/personal/family', { transactionId: id, labelId });
    });
    if (ok) {
      setAdding(null);
      setForm({ name: '', group: 'family' });
    }
  }

  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <HeartHandshake className="size-4 text-rose-600" aria-hidden />
          Between family
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {sent > 0 && `${wholeMoney(sent)} sent`}
            {sent > 0 && received > 0 && ' · '}
            {received > 0 && `${wholeMoney(received)} received`}
          </span>
        </span>
      }
      className="mb-5"
    >
      {error && <Banner>{error}</Banner>}
      <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
        {rows.map((r) => {
          const gi = info(r.group);
          const I = gi.icon;
          return (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="w-12 shrink-0 text-xs text-slate-500">{dayLabel(r.posted)}</span>
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full" style={{ background: `${gi.colour}22`, color: gi.colour }} title={gi.label}>
                  <I className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-slate-500">{r.account}</span>
                </span>
                <span className={cx('font-medium tabular-nums', r.amount > 0 && 'text-emerald-600 dark:text-emerald-400')}>
                  {r.amount > 0 ? '+' : '−'}
                  {wholeMoney(Math.abs(r.amount))}
                </span>
                {readOnly ? (
                  <span className="w-full text-right text-xs text-slate-500 sm:w-44">{r.label ?? 'No category'}</span>
                ) : (
                  <select
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs sm:w-44 dark:border-slate-700 dark:bg-slate-900"
                    value={adding === r.id ? NEW_LABEL : (r.labelId ?? '')}
                    disabled={busy}
                    onChange={(e) => choose(r.id, e.target.value)}
                    aria-label={`Category for ${r.name} on ${dayLabel(r.posted)}`}
                  >
                    <option value="">No category</option>
                    {data.familyLabels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                    <option value={NEW_LABEL}>New category…</option>
                  </select>
                )}
              </div>
              {adding === r.id && (
                <form onSubmit={addLabel} className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:bg-slate-800/60">
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                    New category
                    <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Such as Birthday gift" maxLength={60} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                    Counts as
                    <select
                      className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                      value={form.group}
                      onChange={(e) => setForm({ ...form, group: e.target.value })}
                    >
                      {SPENDING_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {info(k).label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" busy={busy} disabled={!form.name.trim()}>
                      Add
                    </Button>
                    <Button type="button" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Money moved between two people's accounts counts as money out for one and in for the other. A category decides what kind of spending it is for whoever sent it, such as Education for university
        fees, and shows on both sides.
      </p>
    </Card>
  );
}

/* ---------- Budgets ---------- */

function Budgets({ data, onChange, readOnly }: { data: PersonalData; onChange: () => void; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = data.detail;
  const yearly = data.period === 'year';
  // How far through the month (or year) today is.
  const dayOfMonth = Number(data.today.slice(8, 10));
  const daysThisMonth = new Date(Date.UTC(Number(data.thisMonth.slice(0, 4)), Number(data.thisMonth.slice(5)), 0)).getUTCDate();
  const dayShare = !data.current ? (data.future ? 0 : 1) : yearly ? (Number(data.thisMonth.slice(5)) - 1 + dayOfMonth / daysThisMonth) / 12 : dayOfMonth / d.pace.days;
  const person = data.person?.id ?? null;
  const rows = d.groups.filter((g) => g.key !== 'other' && (g.amount > 0 || g.budget !== null || g.typical > 0));
  const missing = rows.filter((g) => g.budget === null && g.typical > 0);
  const totalBudget = rows.reduce((s, g) => s + (g.budget ?? 0), 0);
  const totalSpent = rows.filter((g) => g.budget !== null).reduce((s, g) => s + g.amount, 0);

  async function save(group: string, monthly: number | null) {
    setBusy(true);
    setError('');
    try {
      await post('/api/personal/budgets', { group, monthly, person });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  async function fromTypical() {
    setBusy(true);
    setError('');
    try {
      for (const g of missing) await post('/api/personal/budgets', { group: g.key, monthly: Math.ceil(data.typical[g.key] / 10) * 10, person });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          Budgets
          {totalBudget > 0 && (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {wholeMoney(totalSpent)} of {wholeMoney(totalBudget)} {data.future ? 'planned' : 'used'}
            </span>
          )}
        </span>
      }
      className="mb-5"
      actions={
        missing.length > 0 && !readOnly ? (
          <Button busy={busy} onClick={fromTypical}>
            <Sparkles className="size-4" aria-hidden />
            Suggest from typical months
          </Button>
        ) : undefined
      }
    >
      {error && <Banner>{error}</Banner>}
      {!rows.length ? (
        <p className="py-4 text-center text-sm text-slate-500">{readOnly ? 'No budgets yet.' : "Once there's some spending, set a monthly budget for each kind here."}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((g) => (
            <Envelope
              key={g.key}
              group={g}
              monthly={data.budgets[g.key] ?? null}
              typicalMonth={data.typical[g.key] ?? 0}
              yearly={yearly}
              readOnly={readOnly}
              dayShare={dayShare}
              future={data.future}
              busy={busy}
              onSave={(n) => save(g.key, n)}
            />
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {yearly ? 'Budgets are set by the month; the year adds up twelve. ' : ''}The tick on each bar is where you'd usually be by today, counting bills that land on set days. A typical month is the
        middle of your last six.
      </p>
    </Card>
  );
}

function Envelope({
  group,
  monthly,
  typicalMonth,
  yearly,
  readOnly,
  dayShare,
  future,
  busy,
  onSave,
}: {
  group: GroupRow;
  monthly: number | null;
  typicalMonth: number;
  yearly: boolean;
  readOnly: boolean;
  dayShare: number;
  future: boolean;
  busy: boolean;
  onSave: (n: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(monthly ? String(monthly) : '');
  const gi = info(group.key);
  const I = gi.icon;
  const budget = group.budget;
  const spent = future ? 0 : group.amount;
  const share = budget ? spent / budget : null;
  // Where you'd usually be by now: what this kind normally adds up to by today, when
  // that's known (bills land on the same days), or else an even spread through the month.
  const paceShare = budget ? Math.min(1, Math.max(dayShare, group.typicalSoFar !== null ? group.typicalSoFar / budget : 0)) : dayShare;
  const state = share === null ? 'none' : share > 1 ? 'over' : share > paceShare + 0.1 ? 'ahead' : 'ok';
  const bar = state === 'over' ? '#ef4444' : state === 'ahead' ? '#f59e0b' : gi.colour;
  const left = budget !== null ? budget - spent : null;
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800" style={{ background: `linear-gradient(135deg, ${gi.colour}12, transparent 60%)` }}>
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg text-white shadow-sm" style={{ background: gi.colour }}>
          <I className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{gi.label}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            typical {wholeMoney(group.typical)}
            {yearly ? ' a year' : ''}
            {yearly && monthly !== null ? ` · ${wholeMoney(monthly)} a month` : ''}
          </div>
        </div>
        {!editing && !readOnly && (
          <button type="button" onClick={() => setEditing(true)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Set the ${gi.label} budget`}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(value);
            onSave(value.trim() && n > 0 ? n : null);
            setEditing(false);
          }}
        >
          <span className="text-sm text-slate-500">$</span>
          <Input
            inputMode="decimal"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={String(Math.ceil(typicalMonth / 10) * 10 || '')}
            aria-label="Monthly budget"
          />
          <span className="shrink-0 text-xs text-slate-500">a month</span>
          <Button type="submit" disabled={busy} aria-label="Save">
            <Check className="size-4" aria-hidden />
          </Button>
          <Button type="button" onClick={() => setEditing(false)} aria-label="Cancel">
            <X className="size-4" aria-hidden />
          </Button>
        </form>
      ) : (
        <>
          <div className="mt-3 flex items-baseline justify-between text-sm">
            <span className="font-semibold tabular-nums">{future ? (budget ? wholeMoney(budget) : '—') : wholeMoney(spent)}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{budget === null ? 'no budget' : future ? (yearly ? 'a year' : 'a month') : `of ${wholeMoney(budget)}`}</span>
          </div>
          <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            {budget !== null && !future && <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (share ?? 0) * 100)}%`, background: bar }} />}
            {budget !== null && !future && dayShare > 0 && dayShare < 1 && paceShare < 1 && (
              <div className="absolute top-0 h-full w-0.5 bg-slate-500/70" style={{ left: `${paceShare * 100}%` }} aria-hidden />
            )}
          </div>
          {left !== null && !future && (
            <div className={cx('mt-1 text-xs', state === 'over' ? 'text-red-600 dark:text-red-400' : state === 'ahead' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}>
              {state === 'over' ? `${wholeMoney(-left)} over` : `${wholeMoney(left)} left${state === 'ahead' ? ', ahead of pace' : ''}`}
            </div>
          )}
          {yearly && !future && dayShare < 1 && budget !== null && (
            <div className={cx('text-xs', group.projected > budget ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}>
              On track for {wholeMoney(group.projected)} by December
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Spending through the month ---------- */

function Pace({ data }: { data: PersonalData }) {
  const p = data.detail.pace;
  const yearly = p.unit === 'month';
  const title = yearly ? 'Spending through the year' : 'Spending through the month';
  const what = yearly ? 'year' : 'month';
  if (data.future) {
    return (
      <Card title={title}>
        <p className="py-6 text-center text-sm text-slate-500">
          This {what} hasn't started yet. A typical {what} ends near {wholeMoney(p.typical[p.typical.length - 1] ?? 0)}.
        </p>
      </Card>
    );
  }
  const W = 320;
  const H = 150;
  const max = Math.max(1, ...p.actual, ...p.typical, p.budget ?? 0);
  const x = (i: number) => (i / Math.max(1, p.days - 1)) * (W - 8) + 4;
  const y = (v: number) => H - 14 - (v / max) * (H - 26);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const end = p.actual[p.actual.length - 1] ?? 0;
  const typicalSameDay = p.typical[Math.max(0, p.actual.length - 1)] ?? 0;
  const diff = end - typicalSameDay;
  return (
    <Card title={title}>
      <p className="mb-2 text-sm">
        {p.actual.length ? (
          <>
            <span className="font-semibold">{wholeMoney(end)}</span> {yearly ? `through ${MONTHS[p.actual.length - 1]}` : `by day ${p.actual.length}`},{' '}
            <span className={diff > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
              {wholeMoney(Math.abs(diff))} {diff > 0 ? 'more' : 'less'} than a typical {what}
            </span>{' '}
            by then.
          </>
        ) : (
          'No spending yet.'
        )}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label={`Spending added up ${yearly ? 'month by month' : 'day by day'}, beside a typical ${what}`}>
        <defs>
          <linearGradient id="pace-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#f43f5e" stopOpacity="0.35" />
            <stop offset="1" stopColor="#f43f5e" stopOpacity="0" />
          </linearGradient>
        </defs>
        {p.budget !== null && (
          <>
            <line x1={4} x2={W - 4} y1={y(p.budget)} y2={y(p.budget)} stroke="#6366f1" strokeDasharray="2 4" strokeWidth="1.5" />
            <text x={W - 6} y={y(p.budget) - 4} textAnchor="end" className="fill-indigo-500 text-[9px]">
              budget {short(p.budget)}
            </text>
          </>
        )}
        <path d={path(p.typical)} fill="none" className="stroke-slate-400" strokeWidth="2" strokeDasharray="5 4" />
        {p.actual.length > 1 && (
          <>
            <path d={`${path(p.actual)} L${x(p.actual.length - 1)},${H - 14} L${x(0)},${H - 14} Z`} fill="url(#pace-fill)" />
            <path d={path(p.actual)} fill="none" stroke="#f43f5e" strokeWidth="2.5" strokeLinejoin="round" />
            <circle cx={x(p.actual.length - 1)} cy={y(end)} r="4" fill="#f43f5e" />
          </>
        )}
        <line x1={4} x2={W - 4} y1={H - 14} y2={H - 14} className="stroke-slate-300 dark:stroke-slate-700" />
        <text x={4} y={H - 2} className="fill-slate-400 text-[9px]">
          {yearly ? 'Jan' : '1st'}
        </text>
        <text x={W - 4} y={H - 2} textAnchor="end" className="fill-slate-400 text-[9px]">
          {yearly ? 'Dec' : `${p.days}th`}
        </text>
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-slate-600 dark:text-slate-400">
        <Legend colour="#f43f5e" line>
          {spanName(data, true)}
        </Legend>
        <Legend colour="#94a3b8" line>
          Typical {what}
        </Legend>
      </div>
    </Card>
  );
}

/* ---------- Coming up ---------- */

function ComingUp({ data }: { data: PersonalData }) {
  const items = data.upcoming;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <CalendarClock className="size-4 text-teal-600" aria-hidden />
          Coming up in the next five weeks
        </span>
      }
    >
      {!items.length ? (
        <p className="py-4 text-center text-sm text-slate-500">No regular paychecks or bills found yet. They show up once a payment repeats for a few months.</p>
      ) : (
        <ol className="relative space-y-2 border-l-2 border-dashed border-slate-200 pl-4 dark:border-slate-700">
          {items.map((u, i) => {
            const gi = info(u.group);
            const I = gi.icon;
            return (
              <li key={i} className="relative flex items-center gap-3 text-sm">
                <span className="absolute -left-[1.4rem] size-3 rounded-full ring-4 ring-white dark:ring-slate-900" style={{ background: gi.colour }} aria-hidden />
                <span className="w-14 shrink-0 text-xs font-medium text-slate-500">{dayLabel(u.on)}</span>
                <I className="size-4 shrink-0" style={{ color: gi.colour }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className={cx('tabular-nums font-medium', u.amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : '')}>
                  {u.amount > 0 ? '+' : '−'}
                  {wholeMoney(Math.abs(u.amount))}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {data.recurring.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-400">All {plural(data.recurring.length, 'regular payment')}</summary>
          <ul className="mt-2 space-y-1">
            {data.recurring.map((r) => (
              <li key={r.key} className="flex gap-2 text-xs">
                <span className="w-12 text-slate-500">day {r.day}</span>
                <span className="flex-1 truncate">{r.name}</span>
                <span className="text-slate-500">{info(r.group).label}</span>
                <span className="w-20 text-right tabular-nums">{money(r.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/* ---------- The biggest, and the year ---------- */

function Biggest({ data, member }: { data: PersonalData; member: boolean }) {
  const list = data.detail.biggest;
  return (
    <Card title={`Biggest spending in ${spanName(data, true)}`}>
      {!list.length ? (
        <p className="py-4 text-center text-sm text-slate-500">{data.future ? 'Not here yet.' : 'Nothing spent.'}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((t, i) => {
            const gi = info(t.group);
            const I = gi.icon;
            return (
              <li key={t.id} className="flex items-center gap-3 text-sm">
                <span className="w-4 text-xs font-bold text-slate-400">{i + 1}</span>
                <span className="flex size-8 items-center justify-center rounded-full" style={{ background: `${gi.colour}22`, color: gi.colour }}>
                  <I className="size-4" aria-hidden />
                </span>
                <TxName id={t.id} member={member} className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {dayLabel(t.posted)} · {gi.label} · {t.account}
                  </div>
                </TxName>
                <span className="font-semibold tabular-nums">{wholeMoney(-t.amount)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function YourYear({ data }: { data: PersonalData }) {
  const y = data.last12;
  const spent = useMemo(() => [...y.spent].sort((a, b) => b.amount - a.amount), [y.spent]);
  const earned = y.earned.reduce((s, g) => s + g.amount, 0);
  const out = spent.reduce((s, g) => s + g.amount, 0);
  const max = Math.max(1, ...spent.map((g) => g.amount));
  return (
    <Card title={`Your last 12 months (${monthName(y.from, true)} ${y.from.slice(0, 4)} – ${monthName(y.to, true)} ${y.to.slice(0, 4)})`}>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <YearStat label="In" value={earned} className="text-emerald-600 dark:text-emerald-400" />
        <YearStat label="Out" value={out} className="text-rose-600 dark:text-rose-400" />
        <YearStat label="Kept" value={earned - out} className="text-indigo-600 dark:text-indigo-400" />
      </div>
      <ul className="space-y-1.5">
        {spent.map((g) => {
          const gi = info(g.key);
          return (
            <li key={g.key} className="grid grid-cols-[8.5rem_1fr_4.5rem] items-center gap-2 text-xs">
              <span className="truncate">{gi.label}</span>
              <span className="h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <span className="block h-full rounded-full" style={{ width: `${(g.amount / max) * 100}%`, background: gi.colour }} />
              </span>
              <span className="text-right tabular-nums">{short(g.amount)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function YearStat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="rounded-lg bg-slate-50 py-2 dark:bg-slate-800/60">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={cx('text-lg font-bold tabular-nums', className)}>{short(value)}</div>
    </div>
  );
}

// Leases as the server sends them, and small helpers for showing them.
export type LeaseStatus = 'active' | 'upcoming' | 'ended';
export type Purpose = 'rent' | 'deposit' | 'refund' | 'applied';

export interface Lease {
  id: number;
  ref: string | null;
  entityId: number | null;
  propertyId: string | null;
  unit: string;
  tenant: string;
  phone: string | null;
  email: string | null;
  start: string;
  end: string | null;
  rent: number | null;
  deposit: number | null;
  channel: string | null;
  ended: boolean;
  note: string | null;
  status: LeaseStatus;
  scheduled: number;
  dueSoFar: number;
  collected: number;
  owed: number;
  depositHeld: number;
  unverified: number;
  // Names that appear on this tenant's bank deposits, used to find their rent.
  payers: string | null;
  // Rent due each month, for a lease with no month-by-month schedule.
  monthlyRent: number | null;
  // Days until the lease ends; null when open-ended.
  daysLeft: number | null;
}
export interface LeaseList {
  leases: Lease[];
  totals: { active: number; rentThisYear: number; owed: number; depositsHeld: number };
  units: { id: string; name: string; entityId: number | null }[];
  // Active leases ending within 45 days, soonest first.
  expiring: Lease[];
}
export type RollState = 'paid' | 'partial' | 'due' | 'missed' | 'vacant';
export interface RentRoll {
  months: string[];
  units: { unit: string; cash: boolean; cells: { month: string; expected: number; paid: number; state: RollState; leases: { id: number; tenant: string }[] }[] }[];
  totals: { month: string; expected: number; collected: number }[];
}
export interface ScheduleMonth {
  month: string;
  amount: number;
  note: string | null;
  paid: number;
  state: 'paid' | 'partial' | 'due' | 'upcoming';
}
export interface LeasePayment {
  id: number;
  date: string;
  amount: number;
  purpose: Purpose;
  channel: string | null;
  note: string | null;
  verified: boolean;
  transactions: number[];
  linked: boolean;
}
export interface LeaseDetailData {
  lease: Lease;
  schedule: ScheduleMonth[];
  payments: LeasePayment[];
}

export const STATUS_LABELS: Record<LeaseStatus, string> = { active: 'Active', upcoming: 'Starting soon', ended: 'Ended' };
export const PURPOSE_LABELS: Record<Purpose, string> = {
  rent: 'Rent',
  deposit: 'Security deposit',
  refund: 'Deposit paid back',
  applied: 'Deposit kept for rent',
};

// Units are named after colours; anything else is slate.
const UNIT_COLOURS: Record<string, string> = {
  blue: 'bg-blue-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-400',
  purple: 'bg-violet-500',
  pink: 'bg-pink-500',
  teal: 'bg-teal-500',
};
export const unitColour = (unit: string) => UNIT_COLOURS[unit.trim().toLowerCase()] || 'bg-slate-400';

export const dayText = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–');

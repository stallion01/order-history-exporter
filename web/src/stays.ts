// Stays from Hospitable: shapes from the server and small helpers for the pages.
import { MONTHS } from './format';

export interface Stay {
  id: string;
  code: string | null;
  platform: string;
  platformLabel: string;
  propertyId: string | null;
  property: string | null;
  status: string;
  bookedAt: string | null;
  arrival: string;
  departure: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
  guest: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  pets: number | null;
  currency: string;
  guestTotal: number | null;
  accommodation: number | null;
  cleaning: number | null;
  hostFees: number | null;
  taxes: number | null;
  payout: number | null;
  // What the bank should receive: for Booking.com, before its commission.
  depositAmount: number | null;
  note: string | null;
  paid: boolean;
  // conflict: the deposit could be made up more than one way; due: on its way;
  // nobank: before the bank records start.
  payment: 'paid' | 'partial' | 'conflict' | 'due' | 'missing' | 'nobank' | 'upcoming' | 'none';
  // Paid towards the stay so far, held as a security deposit, and paid back.
  received: number;
  security: number;
  refunded: number;
  expectedOn: string;
  depositDate: string | null;
}

export interface HospitableStatus {
  connected: boolean;
  fromEnvironment: boolean;
  canStore: boolean;
  lastSuccess: string | null;
  lastAttempt: string | null;
  errors: string[];
  syncing: boolean;
  stays: number;
  properties: number;
  payouts: number;
  payoutsLinked: number;
}

export interface StayList {
  stays: Stay[];
  totals: { stays: number; nights: number; payout: number; paid: number; missing: number; missingCount: number; conflictCount: number; due: number; noBank: number; noBankCount: number; bankStart: string | null; guestTotal: number };
  byProperty: { property: string; propertyId: string | null; stays: number; nights: number; payout: number; averageNightly: number | null; occupancy: number | null }[];
  options: { properties: { id: string; name: string }[]; platforms: string[]; years: string[] };
  status: HospitableStatus;
}

export interface DepositRow {
  id: number;
  posted: string;
  amount: number;
  payee: string;
  account: string;
}

export interface StayDetail {
  stay: Stay;
  lines: { side: 'guest' | 'host'; category: string; label: string; amount: number }[];
  payouts: {
    id: string;
    amount: number;
    paidOn: string;
    bankAccount: string | null;
    matchSource: string | null;
    deposit: DepositRow | null;
    lines: { type: string; amount: number; stayId: string | null; guest: string | null; arrival: string | null }[];
    suggestions: (DepositRow & { exact: boolean })[];
  }[];
  // Each part of a transaction linked to the stay; balance is what is left of it.
  deposits: (DepositRow & { source: string; purpose: 'stay' | 'security' | 'refund'; share: number; balance: number })[];
  suggestions: (DepositRow & { exact: boolean; balance: number })[];
  due: number;
  refundSuggestions: (DepositRow & { exact: boolean; balance: number })[];
  conflicts: Conflict[];
}

export interface Conflict {
  deposit: DepositRow;
  options: { subjects: string[]; total: number; items: { subject: string; kind: 'stay' | 'payout'; id: string; label: string; date: string; detail: string; amount: number; stayIds: string[] }[] }[];
}

export interface AirbnbWeek {
  week: string;
  expected: number;
  matched: number;
  unmatched: number;
  unclaimed: number;
  status: 'paid' | 'conflict' | 'missing' | 'extra' | 'due' | 'nobank';
  items: { kind: 'payout' | 'stay'; id: string; date: string; amount: number; deposit: { id: number; posted: string; amount: number } | null; stays: { id: string | null; guest: string; amount: number }[]; status: string }[];
  extras: { id: number; posted: string; amount: number; conflict: boolean }[];
}

export interface AirbnbWeeks {
  weeks: AirbnbWeek[];
  totals: { expected: number; matched: number; unclaimed: number; weeks: number; weeksToCheck: number; bankStart: string | null };
}

export const PLATFORM_NAMES: Record<string, string> = { airbnb: 'Airbnb', vrbo: 'Vrbo', booking: 'Booking.com', direct: 'Direct' };

// The same colours as the income chart on the dashboard.
export function platformColor(platform: string) {
  if (platform === 'airbnb') return 'var(--color-airbnb)';
  if (platform === 'vrbo' || platform === 'homeaway') return 'var(--color-vrbo)';
  if (platform === 'booking') return 'var(--color-booking)';
  return 'var(--color-other-income)';
}

const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y, m, d };
};
export const shortDate = (iso: string) => {
  const { m, d } = day(iso);
  return `${MONTHS[m - 1]} ${d}`;
};
export const longDate = (iso: string) => {
  const { y, m, d } = day(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
// "Mar 2 – 5, 2026", "Mar 30 – Apr 2, 2026", "Dec 30, 2025 – Jan 2, 2026"
export function dateRange(from: string, to: string) {
  const a = day(from);
  const b = day(to);
  if (a.y !== b.y) return `${longDate(from)} – ${longDate(to)}`;
  if (a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} – ${b.d}, ${a.y}`;
  return `${shortDate(from)} – ${shortDate(to)}, ${a.y}`;
}

export function partyText(s: Pick<Stay, 'adults' | 'children' | 'infants' | 'pets'>) {
  const parts: string[] = [];
  const add = (n: number | null, one: string, many: string) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(s.adults, 'adult', 'adults');
  add(s.children, 'child', 'children');
  add(s.infants, 'infant', 'infants');
  add(s.pets, 'pet', 'pets');
  return parts.join(', ');
}

// A time from Hospitable ("2026-03-02T16:00:00-05:00") as the property's local time.
export function localTime(iso: string | null) {
  const match = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!match) return null;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

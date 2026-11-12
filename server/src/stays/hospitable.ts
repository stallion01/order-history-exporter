// Hospitable's public API (read-only use): properties, reservations with their guest
// and money, and Airbnb payouts with what each one paid for.
// https://developer.hospitable.com/docs/public-api-docs/
// Amounts arrive in cents.

type Fetch = typeof fetch;
const BASE = 'https://public.api.hospitable.com/v2';
const TIMEOUT_MS = 60000;
const MAX_PAGES = 100;

export class HospitableError extends Error {}

interface Money {
  amount: number | null;
  label?: string;
  category?: string;
}

export interface HospitableProperty {
  id: string;
  name?: string;
  public_name?: string;
  address?: { city?: string; state?: string } | null;
}

export interface HospitableReservation {
  id: string;
  code?: string | null;
  platform?: string | null;
  booking_date?: string | null;
  arrival_date: string;
  departure_date: string;
  check_in?: string | null;
  check_out?: string | null;
  nights?: number | null;
  status?: string | null;
  guests?: { adult_count?: number; child_count?: number; infant_count?: number; pet_count?: number } | null;
  guest?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone_numbers?: string[] | null; location?: string | null } | null;
  properties?: { id: string }[] | null;
  financials?: {
    currency?: string;
    guest?: { total_price?: Money; fees?: Money[]; taxes?: Money[]; discounts?: Money[]; accommodation?: Money };
    host?: { accommodation?: Money; guest_fees?: Money[]; host_fees?: Money[]; discounts?: Money[]; adjustments?: Money[]; taxes?: Money[]; revenue?: Money };
  } | null;
}

export interface HospitablePayout {
  id: string;
  platform?: string | null;
  bank_account?: string | null;
  amount?: { amount: number | null } | null;
  date: string;
}

export interface HospitableTransaction {
  id: string;
  type?: string | null;
  date?: string | null;
  paid_out_amount?: { amount: number | null } | null;
  payout?: { id: string } | null;
  reservation?: { id: string } | null;
}

export function hospitableClient(token: string, fetchImpl: Fetch = fetch) {
  async function get<T>(path: string): Promise<{ data: T[]; meta?: { last_page?: number } }> {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HospitableError("Hospitable couldn't be reached. It will be tried again later.");
    }
    if (response.status === 401) throw new HospitableError('Hospitable refused the token. It may have expired or been revoked; add a new one in Settings.');
    if (response.status === 403) throw new HospitableError("The Hospitable token isn't allowed to read this. Make a token with read access to reservations and financials.");
    if (response.status === 429) throw new HospitableError('Hospitable is busy. It will be tried again later.');
    if (!response.ok) throw new HospitableError(`Hospitable replied with an error (${response.status}). It will be tried again later.`);
    return response.json() as Promise<{ data: T[]; meta?: { last_page?: number } }>;
  }

  async function all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await get<T>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...(body.data || []));
      if (!body.meta?.last_page || page >= body.meta.last_page) break;
    }
    return out;
  }

  return {
    properties: () => all<HospitableProperty>('/properties'),
    reservations(propertyIds: string[], start: string, end: string) {
      if (!propertyIds.length) return Promise.resolve([] as HospitableReservation[]);
      const ids = propertyIds.map((id) => `properties[]=${encodeURIComponent(id)}`).join('&');
      return all<HospitableReservation>(`/reservations?${ids}&start_date=${start}&end_date=${end}&include=guest,financials,properties`);
    },
    payouts: () => all<HospitablePayout>('/payouts'),
    transactions: () => all<HospitableTransaction>('/transactions?include=reservation,payout'),
  };
}

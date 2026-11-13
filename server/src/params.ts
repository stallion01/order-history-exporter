// Request checking shared by the routes. Anything unexpected is a 400, never a guess.
import { FORMS } from './legacy';
import type { Filters, SortPage } from './legacy';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
const STORE_ID = /^[a-z0-9_-]{1,40}$/i;
const MAX_PAGE = 200;

export const STATUSES = ['business', 'personal'];
// store_card: at that store, business only when paid with a Business account's card.
export const RULE_FIELDS = ['zip', 'payment', 'store', 'category', 'store_card'];

export type Query = URLSearchParams;
// A repeated key (?store=a&store=b) arrives as an array; keep each value.
export const queryOf = (raw: unknown): Query =>
  new URLSearchParams(
    Object.entries((raw as Record<string, unknown>) || {}).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => [k, String(one)] as [string, string]))
  );

export function dateParam(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) throw new HttpError(400, `${name} must look like YYYY-MM-DD.`);
  return value;
}

export function storeParam(value: unknown): string {
  if (typeof value !== 'string' || !STORE_ID.test(value)) throw new HttpError(400, 'A valid store is required.');
  return value;
}

export function textParam(value: unknown, name: string, max = 200): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${name} is missing or too long.`);
  return text;
}

const MAX_CHOICES = 100;

// Every non-empty value of a key, or null when there are none.
function listParam(query: Query, key: string, check?: (value: string) => string): string[] | null {
  const values = query.getAll(key).filter(Boolean);
  if (values.length > MAX_CHOICES) throw new HttpError(400, `Too many ${key} choices.`);
  return values.length ? values.map((v) => (check ? check(v) : v)) : null;
}

export function filtersFrom(query: Query): Filters {
  const status = query.get('status') || null;
  if (status && ![...STATUSES, 'unreviewed', 'notpersonal'].includes(status)) throw new HttpError(400, 'Unknown status.');
  return {
    from: dateParam(query.get('from'), 'from'),
    to: dateParam(query.get('to'), 'to'),
    years: listParam(query, 'years', (v) => {
      if (!YEAR.test(v)) throw new HttpError(400, 'years must look like 2025.');
      return v;
    }),
    store: listParam(query, 'store', storeParam),
    payment: listParam(query, 'payment'),
    zip: listParam(query, 'zip'),
    category: listParam(query, 'category'),
    q: query.get('q') || null,
    status,
  };
}

export const sortFrom = (query: Query): SortPage => ({
  sort: query.get('sort') || 'date',
  direction: query.get('dir') === 'asc' ? 'asc' : 'desc',
});

export const pageFrom = (query: Query): SortPage => ({
  limit: Math.min(Math.max(Number(query.get('limit')) || 50, 1), MAX_PAGE),
  offset: Math.max(Number(query.get('offset')) || 0, 0),
});

export function formParam(value: unknown): string {
  if (typeof value !== 'string' || !FORMS[value]) throw new HttpError(400, 'Unknown tax form.');
  return value;
}

export function lineParam(form: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!FORMS[form].lines.some(([line]) => line === String(value))) throw new HttpError(400, 'Unknown form line.');
  return String(value);
}

export function taxFilters(query: Query): Filters {
  const year = query.get('year');
  if (year && !YEAR.test(year)) throw new HttpError(400, 'year must look like 2025.');
  return {
    from: year ? `${year}-01-01` : null,
    to: year ? `${year}-12-31` : null,
    zip: query.get('zip') || null,
    store: null,
    payment: null,
    q: null,
    category: null,
    status: null,
  };
}

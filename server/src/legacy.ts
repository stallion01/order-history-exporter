// Typed doorway to the order, category and tax logic written in plain JavaScript.
// That code is shared with the extension's tests and stays as it is.
import type { DatabaseSync } from 'node:sqlite';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface Filters {
  from: string | null;
  to: string | null;
  // Each list matches any of its values; a single string is also accepted.
  years?: string[] | string | null;
  store: string[] | string | null;
  payment: string[] | string | null;
  zip: string[] | string | null;
  category: string[] | string | null;
  q: string | null;
  status: string | null;
}

export interface SortPage {
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface OrdersDb {
  saveOrders(store: string, orders: Any[]): { inserted: number; updated: number };
  addCoverage(store: string, ranges: { from: string | null; to: string }[]): Any;
  coverage(store: string): { from: string; to: string }[];
  syncPlan(store: string, range: { from: string | null; to: string | null }, options?: { full?: boolean }): Any;
  recordRun(store: string, run: Any): void;
  report(filters: Partial<Filters>): Any;
  listOrders(filters: Partial<Filters>, options?: SortPage): { total: number; orders: Any[] };
  listItems(filters: Partial<Filters>, options?: SortPage): { total: number; amount: number; items: Any[] };
  enrichedItems(filters: Partial<Filters>): Any[];
  status(): Any;
  categoryList(): { name: string; scheduleC: string | null; scheduleE: string | null }[];
  setItemCategory(name: string, category: string | null): void;
  saveCategory(category: { name: string; scheduleC: string | null; scheduleE: string | null }): void;
  taxRules(): { id: number; field: string; value: string; status: string }[];
  saveTaxRule(rule: { field: string; value: string; status: string }): void;
  deleteTaxRule(id: number): void;
  markItems(items: { store: string; orderId: string; name: string }[], status: string | null): void;
  taxReport(form: string, filters: Partial<Filters>): Any;
  raw: DatabaseSync;
  close(): void;
}

export interface Core {
  csvCell(value: unknown): string;
  toCsv(orders: Any[], layout?: 'items' | 'orders'): string;
}

export const { openDatabase } = require('../db') as { openDatabase(file: string): OrdersDb };
export const core = require('../core') as Core;
export const { FORMS, cents } = require('../tax') as {
  FORMS: Record<string, { name: string; lines: [string, string][] }>;
  cents(n: number): number;
};

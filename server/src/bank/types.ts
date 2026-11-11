// Shapes shared by the bank importers, SimpleFIN and the store.

// One transaction as a source reports it. Money out is negative.
export interface IncomingTransaction {
  // The source's own id for it (SimpleFIN id, OFX FITID, a CSV reference column).
  // Without one, an id is made from the date, amount, description and position.
  externalId: string | null;
  posted: string; // YYYY-MM-DD
  amount: number;
  description: string;
  memo?: string | null;
  // A clean payee name, when the source gives one (SimpleFIN often does).
  payee?: string | null;
}

export type AccountKind = 'checking' | 'savings' | 'credit' | 'other';
export type Owner = 'business' | 'personal' | 'mixed';
export type Source = 'simplefin' | 'ofx' | 'csv';

export const ACCOUNT_KINDS: AccountKind[] = ['checking', 'savings', 'credit', 'other'];
export const OWNERS: Owner[] = ['business', 'personal', 'mixed'];
export const TX_KINDS = ['normal', 'transfer', 'ignored'] as const;
export type TxKind = (typeof TX_KINDS)[number];
export const TX_STATUSES = ['business', 'personal'] as const;

// Whole cents, so amounts compare exactly.
export const toCents = (amount: number) => Math.round(amount * 100);

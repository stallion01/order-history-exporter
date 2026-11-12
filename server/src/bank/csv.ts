// Reads bank and card CSV exports. Every bank lays these out differently, so the
// columns are guessed from the headings, shown to the user to confirm or change,
// and remembered by heading for that bank's next file.
import type { IncomingTransaction } from './types';

export interface CsvMapping {
  date: number;
  description: number;
  // Either one signed amount column, or separate money-out and money-in columns.
  amount: number | null;
  debit: number | null;
  credit: number | null;
  memo: number | null;
  reference: number | null;
  // Some cards list purchases as positive numbers. Flipping makes money out negative.
  flip: boolean;
  // Some banks give every amount as a positive number, with a column saying which
  // way it went ("Debit"/"Credit", "DR"/"CR"). That column decides the sign.
  direction?: number | null;
  dateOrder: 'mdy' | 'dmy' | 'ymd';
}

export interface CsvTable {
  headerRow: number; // where the headings are, after any lines a bank puts above them
  headers: string[];
  rows: string[][];
}

const MAX_ROWS = 50000;

// RFC 4180: quoted fields may hold the delimiter, quotes ("") and line breaks.
export function parseCsvText(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      if (rows.length > MAX_ROWS) throw new Error(`This file has more than ${MAX_ROWS.toLocaleString()} rows. Split it into smaller files.`);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const DATE_HEAD = /date|posted/i;
const MONEY_HEAD = /amount|debit|credit|withdraw|deposit|charge|payment|money|paid|spent|received|inflow|outflow|value/i;

export function readTable(text: string): CsvTable {
  const all = parseCsvText(text);
  // The first row with a date heading and a money heading; banks sometimes put
  // account details above it.
  const headerRow = all.slice(0, 20).findIndex((row) => row.length >= 3 && row.some((c) => DATE_HEAD.test(c)) && row.some((c) => MONEY_HEAD.test(c)));
  if (headerRow < 0) throw new Error("Couldn't find the column headings. The file needs a row naming the date, description and amount columns.");
  const headers = all[headerRow];
  return { headerRow, headers, rows: all.slice(headerRow + 1).filter((row) => row.length >= Math.min(3, headers.length)) };
}

// The headings, as a key to remember this bank's layout by.
export const layoutSignature = (headers: string[]) => headers.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim()).join('|');

const findColumn = (headers: string[], patterns: RegExp[], exclude: number[] = []) => {
  for (const pattern of patterns) {
    const index = headers.findIndex((h, i) => !exclude.includes(i) && pattern.test(h.trim()));
    if (index >= 0) return index;
  }
  return null;
};

export function guessMapping(table: CsvTable): CsvMapping {
  const { headers, rows } = table;
  const date = findColumn(headers, [/^post(ed|ing)? ?date$/i, /^date$/i, /^trans(action)?\.? ?date$/i, /date/i]) ?? 0;
  const description = findColumn(headers, [/^description$/i, /^payee$/i, /^merchant/i, /^name$/i, /^details$/i, /description|details|payee|merchant|narrative/i], [date]) ?? 1;
  const amount = findColumn(headers, [/^amount$/i, /^transaction amount$/i, /amount/i], [date, description]);
  const debit = amount === null ? findColumn(headers, [/debit|withdrawal|money out|paid out|outflow|spent|charge/i], [date, description]) : null;
  const credit = amount === null ? findColumn(headers, [/credit|deposit|money in|paid in|inflow|received|payment/i], [date, description, ...(debit === null ? [] : [debit])]) : null;
  const memo = findColumn(headers, [/^memo$/i, /^notes?$/i, /extended details/i], [date, description]);
  const reference = findColumn(headers, [/^reference/i, /transaction id|^ref(erence)?( ?(no|number|#))?$/i], [date, description]);

  // Date order: a first part over 12 means day first; a four-digit first part means year first.
  let dateOrder: CsvMapping['dateOrder'] = 'mdy';
  const samples = rows.slice(0, 50).map((r) => r[date] || '');
  if (samples.some((s) => /^\d{4}[-/.]/.test(s))) dateOrder = 'ymd';
  else if (samples.some((s) => /^(1[3-9]|2\d|3[01])[-/.]\d{1,2}[-/.]/.test(s))) dateOrder = 'dmy';

  // A column that only says which way the money went.
  let direction: number | null = null;
  if (amount !== null) {
    direction = headers.findIndex((h, i) => {
      if ([date, description, amount, memo, reference].includes(i) || !/type|cr\s*\/?\s*dr|dr\s*\/?\s*cr|debit\s*\/?\s*credit|credit\s*\/?\s*debit|details|direction|indicator/i.test(h)) return false;
      const values = rows.slice(0, 200).map((r) => (r[i] || '').trim()).filter(Boolean);
      return values.length >= 2 && values.filter((v) => directionOf(v) !== null).length / values.length >= 0.9;
    });
    if (direction < 0) direction = null;
  }
  const signed = (row: string[]) => {
    const n = amount === null ? null : parseAmount(row[amount]);
    if (n === null || direction === null) return n;
    const way = directionOf(row[direction] || '');
    return way === null ? n : way * Math.abs(n);
  };

  // Should the amounts be flipped? Descriptions settle it when they can: a payout,
  // deposit or card payment is money in, a purchase or withdrawal is money out. Only
  // with nothing to go on do mostly-positive amounts mean a card that lists purchases
  // as positive. (A rental account full of Airbnb payouts is mostly positive too.)
  let flip = false;
  if (amount !== null && direction === null) {
    const values = rows.map((r) => ({ n: signed(r), text: `${r[description] || ''} ${memo === null ? '' : r[memo] || ''}` })).filter((v) => v.n !== null && v.n !== 0);
    let asIs = 0;
    let flipped = 0;
    for (const { n, text } of values) {
      const way = MONEY_IN.test(text) ? 1 : MONEY_OUT.test(text) ? -1 : 0;
      if (!way) continue;
      if (Math.sign(n!) === way) asIs++;
      else flipped++;
    }
    if (asIs + flipped >= 2 && Math.max(asIs, flipped) / (asIs + flipped) >= 0.75) flip = flipped > asIs;
    else flip = values.length >= 3 && values.filter((v) => v.n! > 0).length / values.length > 0.7;
  }
  return { date, description, amount, debit, credit, memo, reference, flip, dateOrder, direction };
}

// Wording that shows which way money went, used only to check the signs of a file.
export const MONEY_IN =
  /payout|\bdeposit|direct dep|payroll|\bach credit|interest (paid|earned)|wire in\b|wire type:wire in|airbnb \d{3,}|transfer from|zelle from|from (chk|sav|checking|savings)|airbnb.*(payment|payout|transfer|\bach\b)|homeaway|vrbo.*(payout|payment)|booking\.com.*(\bbv\b|b\.v\.|payment|payout|transfer)|payment\s*-?\s*thank you|thank you for your payment|payment received|autopay payment|^payment$/i;
export const MONEY_OUT = /\bpurchase|\bpos\b|debit card|check ?card|withdrawal|\batm\b|^check\b|check #|zelle to|transfer to|to (chk|sav|checking|savings)|bill pay|\bfee\b|payment to\b|wire out|wire type:wire out/i;

// +1 for money in, -1 for money out, null when the text says neither.
export function directionOf(text: string): 1 | -1 | null {
  const t = text.trim().toLowerCase();
  if (/^(c|cr|credit|deposit|in|money in|received|incoming)$/.test(t)) return 1;
  if (/^(d|dr|debit|withdrawal|out|money out|sent|outgoing|payment|purchase|check)$/.test(t)) return -1;
  return null;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

export function parseDate(value: string | undefined, order: CsvMapping['dateOrder'] = 'mdy'): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/.exec(text);
  if (m) {
    const [a, b, c] = [+m[1], +m[2], +m[3]];
    if (m[1].length === 4 || order === 'ymd') return valid(a, b, c);
    return order === 'dmy' ? valid(fullYear(c), b, a) : valid(fullYear(c), a, b);
  }
  // 15 Jan 2026, 15-Jan-26, Jan 15, 2026
  m = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-,]+(\d{2,4})/i.exec(text);
  if (m && MONTH_NAMES.includes(m[2].toLowerCase())) return valid(fullYear(+m[3]), MONTH_NAMES.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})/i.exec(text);
  if (m && MONTH_NAMES.includes(m[1].toLowerCase())) return valid(fullYear(+m[3]), MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return null;
}

// $1,234.56  -12.34  (12.34)  12.34-  12.34 CR  12.34 DR
export function parseAmount(value: string | undefined): number | null {
  let text = String(value || '').trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (/\bDR$/i.test(text)) {
    negative = true;
    text = text.replace(/\s*DR$/i, '');
  }
  text = text.replace(/\s*CR$/i, '');
  text = text.replace(/[$€£\s]/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) text = text.slice(1);
  text = text.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(text)) return null;
  const n = Number(text);
  return negative ? -n : n;
}

export interface CsvResult {
  transactions: IncomingTransaction[];
  skipped: { row: number; reason: string }[];
}

export function applyMapping(table: CsvTable, mapping: CsvMapping): CsvResult {
  const transactions: IncomingTransaction[] = [];
  const skipped: CsvResult['skipped'] = [];
  const cell = (row: string[], index: number | null) => (index === null || index < 0 ? '' : row[index] ?? '');
  table.rows.forEach((row, i) => {
    const rowNumber = table.headerRow + i + 2; // as a spreadsheet would number it
    const posted = parseDate(cell(row, mapping.date), mapping.dateOrder);
    if (!posted) return skipped.push({ row: rowNumber, reason: `No date I can read in "${cell(row, mapping.date)}"` });
    let amount: number | null;
    if (mapping.amount !== null) {
      amount = parseAmount(cell(row, mapping.amount));
      const way = mapping.direction === null || mapping.direction === undefined ? null : directionOf(cell(row, mapping.direction));
      if (amount !== null && way !== null) amount = way * Math.abs(amount);
      else if (amount !== null && mapping.flip) amount = -amount;
    } else {
      const out = parseAmount(cell(row, mapping.debit));
      const inn = parseAmount(cell(row, mapping.credit));
      amount = out === null && inn === null ? null : (inn ? Math.abs(inn) : 0) - (out ? Math.abs(out) : 0);
    }
    if (amount === null) return skipped.push({ row: rowNumber, reason: 'No amount' });
    const description = cell(row, mapping.description) || cell(row, mapping.memo) || 'Transaction';
    const memo = cell(row, mapping.memo);
    transactions.push({
      externalId: cell(row, mapping.reference) || null,
      posted,
      amount: Math.round(amount * 100) / 100,
      description,
      memo: memo && memo !== description ? memo : null,
    });
  });
  return { transactions, skipped };
}

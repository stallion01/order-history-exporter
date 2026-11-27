// Reads Venmo's monthly statement CSVs (venmo.com, Statements, download as CSV).
//
// Each row is one Venmo payment, with where its money came from or went. A payment
// Venmo took from a bank account or card (the Funding Source) never touched the Venmo
// balance, and the bank shows it again as "VENMO PAYMENT"; money Venmo sent straight
// on to a bank (the Destination) is the same the other way. So such a payment is read
// as two rows: the money moving between the bank and Venmo, which is paired with the
// bank's line as a transfer, and the payment itself, which is the spending. The rows
// then add up to the change in the Venmo balance, which the statement gives to check.
import { parseCsvText } from './csv';
import type { IncomingTransaction } from './types';

export interface VenmoStatement {
  // The account's Venmo username (@name), to recognise it next time.
  handle: string | null;
  beginning: number | null;
  ending: number | null;
  firstDate: string | null;
  lastDate: string | null;
  transactions: IncomingTransaction[];
  // Rows left out, such as payments still pending or cancelled.
  skipped: { posted: string; description: string; reason: string }[];
  // Whether the rows add up to the change in the balance.
  balanced: boolean;
}

// The ids of the rows a payment is split into, after the Venmo id. A row without one
// is the payment itself.
export const VENMO_FUNDING = ':fund';
export const VENMO_TO_BANK = ':bank';

const money = (text: string | undefined): number | null => {
  const m = (text ?? '').replace(/\s+/g, '').match(/^([+-])?\$?([\d,]+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return m[1] === '-' ? -n : n;
};
const cents = (n: number) => Math.round(n * 100);
// "Venmo balance", or nothing, means the Venmo balance itself.
const outside = (source: string) => Boolean(source) && !/venmo balance/i.test(source);

export const looksLikeVenmo = (text: string) => /Account Statement - \(@/.test(text.slice(0, 300)) || /,ID,Datetime,Type,Status,Note,From,To,Amount \(total\)/.test(text.slice(0, 2000));

export function parseVenmoStatement(text: string): VenmoStatement {
  const rows = parseCsvText(text);
  const at = rows.findIndex((r) => r.includes('ID') && r.includes('Datetime') && r.includes('Amount (total)'));
  if (at < 0) throw new Error('This is not a Venmo statement. On venmo.com, open Statements and download one as CSV.');
  const header = rows[at];
  const col = (name: string) => header.indexOf(name);
  const c = {
    id: col('ID'),
    when: col('Datetime'),
    type: col('Type'),
    status: col('Status'),
    note: col('Note'),
    from: col('From'),
    to: col('To'),
    total: col('Amount (total)'),
    funding: col('Funding Source'),
    destination: col('Destination'),
    beginning: col('Beginning Balance'),
    ending: col('Ending Balance'),
  };
  const handle = rows
    .slice(0, at)
    .flat()
    .join(' ')
    .match(/\(@([A-Za-z0-9_-]+)\)/)?.[1];
  const statement: VenmoStatement = { handle: handle ? `@${handle}` : null, beginning: null, ending: null, firstDate: null, lastDate: null, transactions: [], skipped: [], balanced: true };

  for (const r of rows.slice(at + 1)) {
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const id = cell(c.id);
    if (!id) {
      // The rows above and below the payments carry the balances.
      if (statement.beginning === null && money(cell(c.beginning)) !== null) statement.beginning = money(cell(c.beginning));
      if (money(cell(c.ending)) !== null) statement.ending = money(cell(c.ending));
      continue;
    }
    const posted = cell(c.when).slice(0, 10);
    const amount = money(cell(c.total));
    const type = cell(c.type);
    const note = cell(c.note).replace(/\s+/g, ' ');
    const from = cell(c.from);
    const to = cell(c.to);
    const funding = cell(c.funding);
    const destination = cell(c.destination);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(posted) || amount === null) {
      statement.skipped.push({ posted, description: `${type} ${from} ${to}`.trim(), reason: 'its date or amount could not be read' });
      continue;
    }
    if (!amount) continue;
    const status = cell(c.status);
    if (status && !/^(complete|issued)/i.test(status)) {
      statement.skipped.push({ posted, description: `${type}: ${from} to ${to}`, reason: `it is ${status.toLowerCase()}` });
      continue;
    }
    statement.firstDate = !statement.firstDate || posted < statement.firstDate ? posted : statement.firstDate;
    statement.lastDate = !statement.lastDate || posted > statement.lastDate ? posted : statement.lastDate;
    const add = (externalId: string, value: number, description: string, payee: string | null) =>
      statement.transactions.push({ externalId, posted, amount: value, description: description.slice(0, 300), payee: payee ? payee.slice(0, 60) : null, memo: 'Venmo' });

    // Moving money between Venmo and a bank: a cash-out, or money added.
    if (/transfer/i.test(type) && !/merchant/i.test(type)) {
      const bank = amount < 0 ? destination || to : funding || from;
      add(`${id}${amount < 0 ? VENMO_TO_BANK : VENMO_FUNDING}`, amount, amount < 0 ? `Venmo transfer to ${bank || 'bank'}` : `Venmo transfer from ${bank || 'bank'}`, null);
      continue;
    }
    const other = (amount < 0 ? to : from) || 'someone';
    const merchant = /merchant/i.test(type);
    // Paid from a bank or card: the money came into Venmo first.
    if (amount < 0 && outside(funding)) add(`${id}${VENMO_FUNDING}`, -amount, `Venmo paid from ${funding}`, null);
    add(id, amount, merchant ? `${other}${note ? `: ${note}` : ''}` : `Venmo ${amount < 0 ? 'to' : 'from'} ${other}${note ? `: ${note}` : ''}`, other);
    // Received straight into a bank: the money went on out of Venmo.
    if (amount > 0 && outside(destination)) add(`${id}${VENMO_TO_BANK}`, -amount, `Venmo transfer to ${destination}`, null);
  }

  if (statement.beginning !== null && statement.ending !== null) {
    const moved = statement.transactions.reduce((s, t) => s + cents(t.amount), 0);
    statement.balanced = moved === cents(statement.ending) - cents(statement.beginning);
  }
  return statement;
}

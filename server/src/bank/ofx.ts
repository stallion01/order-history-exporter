// Reads and writes OFX statements. QFX (Quicken) and QBO (QuickBooks) files are OFX
// too. Both versions are handled: 1.x is SGML, where values have no closing tag
// (<TRNAMT>-12.34), and 2.x is XML (<TRNAMT>-12.34</TRNAMT>).
import type { AccountKind, IncomingTransaction } from './types';

export interface OfxStatement {
  accountNumber: string | null; // the full number, used only to recognise the account and never stored
  last4: string | null;
  kind: AccountKind;
  currency: string;
  balance: number | null;
  balanceDate: string | null;
  transactions: IncomingTransaction[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

// A leaf value: everything after <TAG> up to the next tag or line end.
function field(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = decode(match[1]).trim();
  return value || null;
}

// Each aggregate's contents. Aggregates always have closing tags, in both versions.
function blocks(text: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) out.push(match[1]);
  return out;
}

// 20260115, 20260115120000, 20260115120000.000[-5:EST] -> 2026-01-15
export function ofxDate(value: string | null): string | null {
  const match = value ? /^(\d{4})(\d{2})(\d{2})/.exec(value) : null;
  if (!match) return null;
  const [, y, m, d] = match;
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${m}-${d}`;
}

function ofxAmount(value: string | null): number | null {
  if (!value) return null;
  let text = value.replace(/\s/g, '');
  // Some banks write a decimal comma.
  if (!text.includes('.') && /,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  text = text.replace(/,/g, '');
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export const looksLikeOfx = (text: string) => /<OFX>/i.test(text) && /<STMTTRN>/i.test(text);

export function parseOfx(text: string): OfxStatement[] {
  if (!/<OFX>/i.test(text)) throw new Error("This doesn't look like an OFX, QFX or QBO file.");
  const statements: OfxStatement[] = [];
  for (const [tag, isCard] of [
    ['STMTRS', false],
    ['CCSTMTRS', true],
  ] as const) {
    for (const block of blocks(text, tag)) {
      const accountNumber = field(block, 'ACCTID');
      const type = (field(block, 'ACCTTYPE') || '').toUpperCase();
      const kind: AccountKind = isCard || type === 'CREDITLINE' ? 'credit' : type === 'SAVINGS' || type === 'MONEYMRKT' ? 'savings' : type === 'CHECKING' ? 'checking' : 'other';
      const ledger = blocks(block, 'LEDGERBAL')[0] || '';
      const transactions: IncomingTransaction[] = [];
      for (const tx of blocks(block, 'STMTTRN')) {
        const posted = ofxDate(field(tx, 'DTPOSTED')) || ofxDate(field(tx, 'DTUSER'));
        const amount = ofxAmount(field(tx, 'TRNAMT'));
        if (!posted || amount === null) continue;
        const name = field(tx, 'NAME') || field(blocks(tx, 'PAYEE')[0] || '', 'NAME');
        const memo = field(tx, 'MEMO');
        transactions.push({
          externalId: field(tx, 'FITID'),
          posted,
          amount,
          description: name || memo || field(tx, 'TRNTYPE') || 'Transaction',
          memo: name && memo && memo !== name ? memo : null,
        });
      }
      statements.push({
        accountNumber,
        last4: accountNumber ? accountNumber.replace(/\D/g, '').slice(-4) || null : null,
        kind,
        currency: (field(block, 'CURDEF') || 'USD').toUpperCase(),
        balance: ofxAmount(field(ledger, 'BALAMT')),
        balanceDate: ofxDate(field(ledger, 'DTASOF')),
        transactions,
      });
    }
  }
  if (!statements.length) throw new Error('No bank or card statement was found in this file.');
  return statements;
}

/* ---------- Writing ---------- */

export interface ExportAccount {
  id: number;
  name: string;
  kind: AccountKind;
  currency: string;
  balance: number | null;
  balanceDate: string | null;
}
export interface ExportTransaction {
  id: number;
  posted: string;
  amount: number;
  description: string;
  memo: string | null;
}

// Each exported transaction's FITID, which a later import recognises as this one.
export const exportFitId = (id: number) => `EH-${id}`;
export const fitIdToTransaction = (fitId: string | null) => {
  const match = fitId ? /^EH-(\d+)$/.exec(fitId) : null;
  return match ? Number(match[1]) : null;
};

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
const stamp = (date: string) => `${date.replace(/-/g, '')}120000`;

// OFX 1.02 (SGML), the version every money program reads.
export function writeOfx(account: ExportAccount, transactions: ExportTransaction[], today: string): string {
  const isCard = account.kind === 'credit';
  const dates = transactions.map((t) => t.posted).sort();
  const start = dates[0] || today;
  const end = dates[dates.length - 1] || today;
  const lines = transactions.map((t) =>
    [
      '<STMTTRN>',
      `<TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}`,
      `<DTPOSTED>${stamp(t.posted)}`,
      `<TRNAMT>${t.amount.toFixed(2)}`,
      `<FITID>${exportFitId(t.id)}`,
      `<NAME>${escape(t.description.slice(0, 32))}`,
      ...(t.memo || t.description.length > 32 ? [`<MEMO>${escape((t.memo || t.description).slice(0, 255))}`] : []),
      '</STMTTRN>',
    ].join('\n')
  );
  const accountFrom = isCard
    ? `<CCACCTFROM>\n<ACCTID>EH${account.id}\n</CCACCTFROM>`
    : `<BANKACCTFROM>\n<BANKID>000000000\n<ACCTID>EH${account.id}\n<ACCTTYPE>${account.kind === 'savings' ? 'SAVINGS' : 'CHECKING'}\n</BANKACCTFROM>`;
  const statement = [
    `<${isCard ? 'CCSTMTRS' : 'STMTRS'}>`,
    `<CURDEF>${account.currency}`,
    accountFrom,
    '<BANKTRANLIST>',
    `<DTSTART>${stamp(start)}`,
    `<DTEND>${stamp(end)}`,
    ...lines,
    '</BANKTRANLIST>',
    ...(account.balance !== null ? ['<LEDGERBAL>', `<BALAMT>${account.balance.toFixed(2)}`, `<DTASOF>${stamp(account.balanceDate || today)}`, '</LEDGERBAL>'] : []),
    `</${isCard ? 'CCSTMTRS' : 'STMTRS'}>`,
  ].join('\n');
  const wrapper = isCard ? ['CREDITCARDMSGSRSV1', 'CCSTMTTRNRS'] : ['BANKMSGSRSV1', 'STMTTRNRS'];
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>',
    `<DTSERVER>${stamp(today)}`,
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    `<${wrapper[0]}>`,
    `<${wrapper[1]}>`,
    '<TRNUID>1',
    '<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>',
    statement,
    `</${wrapper[1]}>`,
    `</${wrapper[0]}>`,
    '</OFX>',
    '',
  ].join('\r\n');
}

// The year-end package: an Excel workbook, a PDF summary, and a ZIP holding both
// with the year's receipts.
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { FORMS } from '../legacy';
import { CLASS_LABELS } from './service';
import type { CpaService } from './service';
import { zip } from './zip';

export interface YearData {
  year: number;
  scope: string; // "All businesses and properties", or one entity's name
  generated: Date;
  summary: ReturnType<CpaService['summary']>;
  lines: ReturnType<CpaService['yearLines']>;
  income: ReturnType<CpaService['income']>;
  transfers: ReturnType<CpaService['transfers']>;
  assets: ReturnType<CpaService['assets']>;
  review: ReturnType<CpaService['review']>;
  possibleCapital: ReturnType<CpaService['possibleCapital']>;
}

const MONEY = '$#,##0.00;[Red]-$#,##0.00';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cents = (n: number) => Math.round(n * 100) / 100;
const formName = (form: 'C' | 'E') => (form === 'E' ? 'Schedule E (rental)' : 'Schedule C (business)');
const lineLabel = (form: 'C' | 'E', line: string | null) => {
  if (!line) return 'Not on a Schedule line';
  const found = FORMS[form === 'E' ? 'schedule-e' : 'schedule-c'].lines.find(([code]) => code === line);
  return found ? `Line ${line}: ${found[1]}` : `Line ${line}`;
};
const STATUS = (s: string | null) => (s === 'business' ? 'Business' : s === 'personal' ? 'Personal' : 'Not decided');

// A file name for a receipt: date, vendor and amount.
export function receiptFileName(r: { date: string | null; vendor: string | null; total: number | null; id: number; mime: string }, taken: Set<string>) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }[r.mime] || 'bin';
  const vendor = (r.vendor || 'receipt').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'receipt';
  const base = `${r.date || 'undated'}_${vendor}_${r.total === null ? 'no-total' : r.total.toFixed(2)}`;
  let name = `${base}.${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}.${ext}`;
  taken.add(name);
  return name;
}

/* ---------- Excel ---------- */

export async function buildWorkbook(data: YearData): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Expense Hub';
  book.created = data.generated;

  const sheet = (name: string, columns: { header: string; key: string; width: number; money?: boolean }[]) => {
    const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: MONEY } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    return ws;
  };
  const filter = (ws: ExcelJS.Worksheet) => {
    if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  };

  // 1. Summary, per business or property.
  const summary = book.addWorksheet('Summary');
  summary.columns = [{ width: 52 }, { width: 18, style: { numFmt: MONEY } }];
  summary.addRow([`Year-end summary ${data.year}`]).font = { bold: true, size: 14 };
  summary.addRow([data.scope]);
  summary.addRow([`Prepared ${data.generated.toISOString().slice(0, 10)} from bank and card transactions in Expense Hub. Store charges matched to orders are split by item.`]);
  for (const g of data.summary) {
    summary.addRow([]);
    summary.addRow([`${g.entity} — ${formName(g.form)}`]).font = { bold: true, size: 12 };
    for (const l of g.lines) summary.addRow([lineLabel(g.form, l.line), l.amount]);
    summary.addRow(['Total expenses on the Schedule (operating and cost of goods sold)', cents(g.opex + g.cogs)]).font = { bold: true };
    if (g.cogs) summary.addRow(['  of which cost of goods sold', g.cogs]);
    summary.addRow(['Capital purchases (see Assets, not expensed)', g.capex]);
    summary.addRow(['Income', g.income]);
    summary.addRow(['Personal spending (left out)', g.personal]);
  }
  summary.addRow([]);
  summary.addRow(['Still to decide (see Needs review)']).font = { bold: true };
  const r = data.review;
  for (const [label, n] of [
    ['Transactions not marked business or personal', r.undecided],
    ['Business transactions without a category', r.uncategorised],
    ['Business transactions without a business or property', r.noEntity],
    ['Purchases of $2,500 or more to check as possible capital', r.possibleCapital],
    ['Store charges not matched to an order', r.unmatchedStoreCharges],
    ['Store orders without a matching charge', r.ordersWithoutCharge],
    ['Receipts not checked', r.receiptsToCheck],
  ] as [string, number][])
    summary.addRow([label, n]).getCell(2).numFmt = '0';

  // 2. Monthly by category (business spending only).
  const monthly = sheet('Monthly by category', [
    { header: 'Category', key: 'category', width: 34 },
    ...MONTHS.map((m, i) => ({ header: m, key: `m${i}`, width: 12, money: true })),
    { header: 'Total', key: 'total', width: 14, money: true },
  ]);
  const grid = new Map<string, number[]>();
  for (const l of data.lines) {
    if (l.class !== 'opex' && l.class !== 'cogs') continue;
    const row = grid.get(l.category) || new Array(12).fill(0);
    row[Number(l.posted.slice(5, 7)) - 1] += l.amount;
    grid.set(l.category, row);
  }
  for (const [category, row] of [...grid.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    monthly.addRow({ category, ...Object.fromEntries(row.map((v, i) => [`m${i}`, cents(v)])), total: cents(row.reduce((a, b) => a + b, 0)) });
  }
  const totals = monthly.addRow({
    category: 'Total',
    ...Object.fromEntries(MONTHS.map((_, i) => [`m${i}`, cents([...grid.values()].reduce((t, row) => t + row[i], 0))])),
    total: cents([...grid.values()].flat().reduce((a, b) => a + b, 0)),
  });
  totals.font = { bold: true };

  // 3. Every line of spending.
  const lines = sheet('Transactions', [
    { header: 'Date', key: 'posted', width: 11 },
    { header: 'Account', key: 'account', width: 20 },
    { header: 'Payee', key: 'payee', width: 24 },
    { header: 'Item (from the store order)', key: 'item', width: 36 },
    { header: 'Order', key: 'order', width: 22 },
    { header: 'Category', key: 'category', width: 28 },
    { header: 'Class', key: 'class', width: 18 },
    { header: 'Business or personal', key: 'status', width: 14 },
    { header: 'Business or property', key: 'entity', width: 22 },
    { header: 'Share', key: 'share', width: 8 },
    { header: 'Schedule line', key: 'line', width: 36 },
    { header: 'Amount', key: 'amount', width: 13, money: true },
    { header: 'Bank description', key: 'description', width: 36 },
    { header: 'Receipt', key: 'receipt', width: 34 },
  ]);
  for (const l of data.lines) {
    lines.addRow({
      posted: l.posted,
      account: l.account,
      payee: l.payee,
      item: l.item?.name ?? '',
      order: l.item ? `${l.item.store} ${l.item.orderId}` : '',
      category: l.category,
      class: CLASS_LABELS[l.class],
      status: STATUS(l.status),
      entity: l.entity ?? 'Not assigned',
      share: l.share === 100 ? '' : `${l.share}%`,
      line: l.class === 'opex' || l.class === 'cogs' ? lineLabel(l.form, l.line) : '',
      amount: cents(l.amount),
      description: l.description,
      receipt: l.receiptId ? `receipts/${(data as YearData & { receiptNames?: Map<number, string> }).receiptNames?.get(l.receiptId) ?? `receipt ${l.receiptId}`}` : '',
    });
  }
  filter(lines);

  // 4. Income.
  const income = sheet('Income', [
    { header: 'Date', key: 'posted', width: 11 },
    { header: 'Account', key: 'account', width: 20 },
    { header: 'Payee', key: 'payee', width: 26 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Business or property', key: 'entity', width: 22 },
    { header: 'Amount', key: 'amount', width: 13, money: true },
    { header: 'Bank description', key: 'description', width: 40 },
  ]);
  for (const t of data.income) income.addRow({ ...t, entity: t.entity ?? 'Not assigned' });
  filter(income);

  // 5. Asset register.
  const assets = sheet('Assets', [
    { header: 'Description', key: 'description', width: 36 },
    { header: 'Placed in service', key: 'placedInService', width: 16 },
    { header: 'Cost', key: 'cost', width: 13, money: true },
    { header: 'Business or property', key: 'entity', width: 22 },
    { header: 'Recovery period (years)', key: 'recovery', width: 22 },
    { header: 'Bought', key: 'source', width: 30 },
    { header: 'Note', key: 'note', width: 36 },
  ]);
  for (const a of data.assets) assets.addRow({ ...a, entity: a.entity ?? 'Not assigned', recovery: a.recovery ?? 'To decide' });
  filter(assets);

  // 6. Transfers and owner draws.
  const transfers = sheet('Transfers', [
    { header: 'Date', key: 'posted', width: 11 },
    { header: 'From', key: 'from', width: 22 },
    { header: 'To', key: 'to', width: 22 },
    { header: 'Amount', key: 'amount', width: 13, money: true },
    { header: 'What it is', key: 'kind', width: 34 },
    { header: 'Bank description', key: 'description', width: 40 },
  ]);
  for (const t of data.transfers) transfers.addRow({ ...t, to: t.to ?? '' });
  filter(transfers);

  // 7. What's left to decide.
  const needs = sheet('Needs review', [
    { header: 'What', key: 'what', width: 44 },
    { header: 'Date', key: 'posted', width: 11 },
    { header: 'Payee', key: 'payee', width: 26 },
    { header: 'Detail', key: 'detail', width: 36 },
    { header: 'Amount', key: 'amount', width: 13, money: true },
  ]);
  for (const p of data.possibleCapital) needs.addRow({ what: 'Possible capital purchase ($2,500 or more)', posted: p.posted, payee: p.payee, detail: p.item ?? p.category, amount: p.amount });
  const seen = new Set<string>();
  for (const l of data.lines) {
    const key = `${l.txId}`;
    if (seen.has(key)) continue;
    if (!l.status) needs.addRow({ what: 'Not marked business or personal', posted: l.posted, payee: l.payee, detail: l.category, amount: cents(l.amount) });
    else if (l.class !== 'personal' && (!l.category || l.category === 'Uncategorized')) needs.addRow({ what: 'No category', posted: l.posted, payee: l.payee, detail: l.description, amount: cents(l.amount) });
    else continue;
    seen.add(key);
  }
  filter(needs);

  return Buffer.from(await book.xlsx.writeBuffer());
}

/* ---------- PDF ---------- */

export function buildPdf(data: YearData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Year-end summary ${data.year}`, Author: 'Expense Hub' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const room = (height: number) => {
      if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
    };
    const row = (label: string, amount: number | string, bold = false) => {
      room(16);
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      doc.text(label, left, y, { width: right - left - 110 });
      const after = doc.y;
      doc.text(typeof amount === 'number' ? money(amount) : amount, right - 110, y, { width: 110, align: 'right' });
      doc.y = Math.max(after, doc.y) + 2;
    };

    doc.font('Helvetica-Bold').fontSize(18).text(`Year-end summary ${data.year}`);
    doc.font('Helvetica').fontSize(10).fillColor('#475569').text(`${data.scope}. Prepared ${data.generated.toISOString().slice(0, 10)} from bank and card records in Expense Hub.`);
    doc.text('Store charges matched to their orders are split by item. Personal spending and transfers between accounts are left out.');
    doc.fillColor('#000').moveDown();

    for (const g of data.summary) {
      room(80);
      doc.font('Helvetica-Bold').fontSize(13).text(`${g.entity} — ${formName(g.form)}`, left);
      doc.moveDown(0.3);
      for (const l of g.lines) row(lineLabel(g.form, l.line), l.amount);
      row('Total expenses', cents(g.opex + g.cogs), true);
      if (g.cogs) row('  of which cost of goods sold', g.cogs);
      row('Capital purchases (on the asset register, not expensed)', g.capex);
      row('Income', g.income);
      doc.moveDown();
    }

    if (data.assets.length) {
      room(60);
      doc.font('Helvetica-Bold').fontSize(13).text('Assets placed in service', left);
      doc.moveDown(0.3);
      for (const a of data.assets) row(`${a.placedInService}  ${a.description}${a.entity ? ` (${a.entity})` : ''}${a.recovery ? `, ${a.recovery}-year` : ''}`, a.cost);
      doc.moveDown();
    }

    const draws = data.transfers.filter((t) => t.kind === 'Owner draw' || t.kind === 'Owner contribution');
    if (draws.length) {
      room(60);
      doc.font('Helvetica-Bold').fontSize(13).text('Owner draws and contributions', left);
      doc.moveDown(0.3);
      row('Owner draws', cents(draws.filter((t) => t.kind === 'Owner draw').reduce((s, t) => s + t.amount, 0)));
      row('Owner contributions', cents(draws.filter((t) => t.kind === 'Owner contribution').reduce((s, t) => s + t.amount, 0)));
      doc.moveDown();
    }

    room(120);
    doc.font('Helvetica-Bold').fontSize(13).text('Still to decide', left);
    doc.moveDown(0.3);
    const r = data.review;
    const open = [
      ['Transactions not marked business or personal', r.undecided],
      ['Business transactions without a category', r.uncategorised],
      ['Business transactions without a business or property', r.noEntity],
      ['Purchases of $2,500 or more to check as possible capital', r.possibleCapital],
      ['Store charges not matched to an order', r.unmatchedStoreCharges],
      ['Receipts not checked', r.receiptsToCheck],
    ].filter(([, n]) => n) as [string, number][];
    if (!open.length) row('Nothing: every transaction has been sorted.', '');
    for (const [label, n] of open) row(label, String(n));
    doc.moveDown();
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('Schedule lines come from each category\'s setting under Tax groups and are suggestions to confirm with your tax preparer. This summary does not calculate depreciation.', left);
    doc.end();
  });
}

/* ---------- The package ---------- */

export async function buildPackage(data: YearData, receipts: ReturnType<CpaService['yearReceipts']>): Promise<Buffer> {
  const taken = new Set<string>();
  const names = new Map<number, string>();
  const files: { name: string; data: Buffer }[] = [];
  for (const r of receipts) {
    if (!r.file || !fs.existsSync(r.file.path)) continue;
    const name = receiptFileName(r, taken);
    names.set(r.id, name);
    files.push({ name: `receipts/${name}`, data: fs.readFileSync(r.file.path) });
  }
  const withNames = Object.assign(data, { receiptNames: names });
  const [xlsx, pdf] = await Promise.all([buildWorkbook(withNames), buildPdf(withNames)]);
  return zip([
    { name: `Year-end summary ${data.year}.pdf`, data: pdf },
    { name: `Expense Hub ${data.year}.xlsx`, data: xlsx },
    ...files,
  ]);
}

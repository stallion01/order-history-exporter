// Receipts: stored files, reading them with Claude in the background, and matching
// each one to the card or bank transaction it belongs to.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { payeeFor } from '../bank/merchant';
import { similarDescriptions } from '../bank/store';
import type { BankStore } from '../bank/store';
import { toCents } from '../bank/types';
import type { SecretBox } from '../secrets';
import { ReaderError } from './reader';
import type { ReceiptReader } from './reader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's limit for one image
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DAY_MS = 86400000;
const KEY_SETTING = 'anthropic.apiKey';
const CASH_SETTING = 'cash.accountId';

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
export const RECEIPT_TYPES = Object.keys(EXTENSIONS);

// What the bytes actually are, whatever the browser said.
export function sniff(data: Buffer): string | null {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export type ReceiptView = 'all' | 'review' | 'unmatched' | 'matched';

export type ReceiptGroup = 'month' | 'vendor' | 'category';
export const RECEIPT_GROUPS: ReceiptGroup[] = ['month', 'vendor', 'category'];

export interface ReceiptFilters {
  view?: ReceiptView;
  from?: string | null;
  to?: string | null;
  years?: string[] | null;
  vendor?: string[] | null; // tidied vendor names; 'none' for receipts without one
  category?: string[] | null; // 'none' for receipts without one
  q?: string | null;
  group?: ReceiptGroup;
}

// A vendor's tidy name, the same way bank payees are named.
const vendorName = (vendor: string | null) => (vendor && vendor.trim() ? payeeFor(vendor) : null);

export interface ReceiptEdit {
  vendor?: string | null;
  date?: string | null;
  total?: number | null;
  tax?: number | null;
  tip?: number | null;
  cardLast4?: string | null;
  category?: string | null;
  note?: string | null;
  checked?: boolean;
}

const now = () => new Date().toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const shift = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
const validDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null);
const money = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

export function receiptService(options: {
  db: DatabaseSync;
  bank: BankStore;
  dataDir: string | null;
  secrets: SecretBox | null;
  reader: ReceiptReader;
  categoryNames: () => string[];
}) {
  const { db, bank, dataDir, secrets, reader, categoryNames } = options;
  const root = dataDir ? path.join(dataDir, 'receipts') : null;

  // Receipts left mid-read by a restart are read again.
  db.prepare(`UPDATE receipts SET status = 'pending' WHERE status = 'reading'`).run();

  /* ---------- The Anthropic API key ---------- */

  const storedKey = () => {
    const sealed = bank.getSetting(KEY_SETTING);
    if (sealed && secrets) return secrets.open(sealed);
    return null;
  };
  const apiKey = () => storedKey() || process.env.ANTHROPIC_API_KEY || null;
  const keyStatus = () => {
    const key = apiKey();
    return { set: Boolean(key), fromEnvironment: !storedKey() && Boolean(process.env.ANTHROPIC_API_KEY), endsWith: key ? key.slice(-4) : null, canStore: Boolean(secrets) };
  };
  function setApiKey(key: string | null) {
    if (key && !secrets) throw new Error('This server has nowhere safe to keep the key.');
    bank.setSetting(KEY_SETTING, key ? secrets!.seal(key) : null);
    if (key) kick();
  }

  /* ---------- Rows ---------- */

  const toReceipt = (row: Row) => ({
    id: row.id,
    fileName: row.file_name,
    mime: row.mime,
    size: row.size,
    hasThumb: Boolean(row.thumb_path),
    status: row.status as 'pending' | 'reading' | 'read' | 'failed',
    readError: row.read_error,
    readAt: row.read_at,
    vendor: row.vendor,
    date: row.receipt_date,
    currency: row.currency,
    subtotal: row.subtotal,
    tax: row.tax,
    tip: row.tip,
    total: row.total,
    cardLast4: row.card_last4,
    paymentMethod: row.payment_method,
    category: row.category,
    items: row.items ? (JSON.parse(row.items) as { description: string; quantity: number | null; unitPrice: number | null; amount: number | null }[]) : [],
    confidence: row.confidence,
    readerNotes: row.reader_notes,
    note: row.note,
    checked: Boolean(row.checked),
    transactionId: row.transaction_id,
    matchSource: row.match_source,
    transaction: row.tx_id
      ? { id: row.tx_id, posted: row.tx_posted, amount: row.tx_amount, payee: row.tx_payee, description: row.tx_description, account: row.tx_account }
      : null,
    createdAt: row.created_at,
  });

  const SELECT = `SELECT r.*, t.id AS tx_id, t.posted AS tx_posted, t.amount AS tx_amount, t.payee AS tx_payee, t.description AS tx_description, a.name AS tx_account
    FROM receipts r LEFT JOIN bank_transactions t ON t.id = r.transaction_id LEFT JOIN bank_accounts a ON a.id = t.account_id`;

  const getRow = (id: number) => db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Row | undefined;
  const get = (id: number) => {
    const row = db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
    return row ? toReceipt(row) : null;
  };

  // The date a receipt is filed under: its own, or the day it was added if not read yet.
  const filedDate = (r: { date: string | null; createdAt: string }) => r.date || r.createdAt.slice(0, 10);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const groupOf = (r: ReturnType<typeof toReceipt>, by: ReceiptGroup): { key: string; label: string } => {
    if (by === 'vendor') {
      const name = vendorName(r.vendor);
      return name ? { key: 'v:' + name.toLowerCase(), label: name } : { key: 'v:', label: 'No vendor yet' };
    }
    if (by === 'category') return r.category ? { key: 'c:' + r.category, label: r.category } : { key: 'c:', label: 'No category' };
    if (!r.date) return { key: 'm:', label: 'No date yet' };
    return { key: 'm:' + r.date.slice(0, 7), label: MONTHS[Number(r.date.slice(5, 7)) - 1] + ' ' + r.date.slice(0, 4) };
  };

  function list(filters: ReceiptFilters = {}, limit = 60, offset = 0) {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const filed = 'COALESCE(r.receipt_date, substr(r.created_at, 1, 10))';
    const marks = (n: number) => new Array(n).fill('?').join(', ');
    if (filters.view === 'review') clauses.push("(r.status = 'failed' OR (r.status = 'pending' AND r.read_error IS NOT NULL) OR (r.status = 'read' AND r.checked = 0))");
    if (filters.view === 'unmatched') clauses.push("r.transaction_id IS NULL AND r.status = 'read'");
    if (filters.view === 'matched') clauses.push('r.transaction_id IS NOT NULL');
    if (filters.from) {
      clauses.push(filed + ' >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push(filed + ' <= ?');
      params.push(filters.to);
    }
    if (filters.years?.length) {
      clauses.push('substr(' + filed + ', 1, 4) IN (' + marks(filters.years.length) + ')');
      params.push(...filters.years);
    }
    if (filters.category?.length) {
      const named = filters.category.filter((c) => c !== 'none');
      const parts = named.length ? ['r.category IN (' + marks(named.length) + ')'] : [];
      params.push(...named);
      if (filters.category.includes('none')) parts.push('r.category IS NULL');
      clauses.push('(' + parts.join(' OR ') + ')');
    }
    if (filters.q) {
      const like = '%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%';
      clauses.push("(r.vendor LIKE ? ESCAPE '\\' OR r.file_name LIKE ? ESCAPE '\\' OR r.note LIKE ? ESCAPE '\\' OR r.items LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    let all = (db.prepare(SELECT + ' ' + where + ' ORDER BY ' + filed + ' DESC, r.id DESC').all(...params) as Row[]).map(toReceipt);
    // Vendors are compared by their tidied name, so "THE HOME DEPOT #2345" is Home Depot.
    if (filters.vendor?.length) {
      const wanted = new Set(filters.vendor.map((v) => v.toLowerCase()));
      all = all.filter((r) => wanted.has((vendorName(r.vendor) || 'none').toLowerCase()));
    }

    // Groups in order: months newest first; vendors and categories A to Z, with the
    // "not known yet" group last. Within a group, newest first.
    const by = filters.group || 'month';
    const groups = new Map<string, { key: string; label: string; count: number; total: number }>();
    for (const r of all) {
      const g = groupOf(r, by);
      const entry = groups.get(g.key) || { ...g, count: 0, total: 0 };
      entry.count++;
      entry.total = Math.round((entry.total + (r.total ?? 0)) * 100) / 100;
      groups.set(g.key, entry);
    }
    const order = [...groups.values()].sort((a, b) => {
      const blankA = a.key.endsWith(':');
      const blankB = b.key.endsWith(':');
      if (blankA !== blankB) return blankA ? 1 : -1;
      return by === 'month' ? b.key.localeCompare(a.key) : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
    const rank = new Map(order.map((g, i) => [g.key, i]));
    all.sort((a, b) => rank.get(groupOf(a, by).key)! - rank.get(groupOf(b, by).key)! || filedDate(b).localeCompare(filedDate(a)) || b.id - a.id);
    return {
      total: all.length,
      receipts: all.slice(offset, offset + limit).map((r) => ({ ...r, group: groupOf(r, by).key })),
      groups: order,
    };
  }

  // Everything that can be filtered on, with how many receipts each has.
  function choices() {
    const rows = db.prepare('SELECT vendor, category, COALESCE(receipt_date, substr(created_at, 1, 10)) AS filed FROM receipts').all() as Row[];
    const tally = (values: (string | null)[]) => {
      const map = new Map<string, number>();
      for (const v of values) if (v) map.set(v, (map.get(v) || 0) + 1);
      return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    };
    return {
      years: [...new Set(rows.map((r) => String(r.filed).slice(0, 4)))].sort().reverse(),
      vendors: tally(rows.map((r) => vendorName(r.vendor))),
      categories: tally(rows.map((r) => r.category)),
    };
  }

  const counts = () => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'failed' OR (status = 'pending' AND read_error IS NOT NULL) OR (status = 'read' AND checked = 0) THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN transaction_id IS NULL AND status = 'read' THEN 1 ELSE 0 END) AS unmatched,
           SUM(CASE WHEN status IN ('pending', 'reading') AND read_error IS NULL THEN 1 ELSE 0 END) AS reading
         FROM receipts`
      )
      .get() as Row;
    return { total: row.total ?? 0, review: row.review ?? 0, unmatched: row.unmatched ?? 0, reading: row.reading ?? 0 };
  };

  /* ---------- Files ---------- */

  const absolute = (relative: string) => {
    if (!root) throw new Error('Receipts are not available on this server.');
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Bad path.');
    return full;
  };
  const filePath = (id: number) => {
    const row = getRow(id);
    return row ? { path: absolute(row.stored_path), mime: row.mime as string, name: `receipt-${id}.${EXTENSIONS[row.mime] || 'bin'}` } : null;
  };
  const thumbPath = (id: number) => {
    const row = getRow(id);
    return row?.thumb_path ? absolute(row.thumb_path) : null;
  };

  function add(input: { originalHash: string | null; fileName: string | null; data: Buffer; thumb: Buffer | null }, username: string | null) {
    if (!root) throw new Error('Receipts are not available on this server.');
    input = { ...input, originalHash: input.originalHash || crypto.createHash('sha256').update(input.data).digest('hex') };
    const existing = db.prepare('SELECT id FROM receipts WHERE original_hash = ?').get(input.originalHash) as Row | undefined;
    if (existing) return { id: existing.id as number, duplicate: true };
    const mime = sniff(input.data);
    if (!mime) throw new Error('That file is not a photo (JPEG, PNG, WebP) or PDF that can be read.');
    if (mime === 'application/pdf' ? input.data.length > MAX_PDF_BYTES : input.data.length > MAX_IMAGE_BYTES) {
      throw new Error(mime === 'application/pdf' ? 'That PDF is larger than 10 MB.' : 'That photo is larger than 5 MB. Take it again at a lower resolution.');
    }
    const thumb = input.thumb && sniff(input.thumb) === 'image/jpeg' && input.thumb.length < 512 * 1024 ? input.thumb : null;
    const id = Number(
      db
        .prepare(`INSERT INTO receipts (original_hash, file_name, mime, size, stored_path, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?)`)
        .run(input.originalHash!, input.fileName, mime, input.data.length, username, now(), now()).lastInsertRowid
    );
    const month = new Date().toISOString().slice(0, 7);
    const stored = path.join(month, `${id}-${input.originalHash!.slice(0, 8)}.${EXTENSIONS[mime]}`);
    try {
      fs.mkdirSync(path.dirname(absolute(stored)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(absolute(stored), input.data, { mode: 0o600 });
      let thumbStored: string | null = null;
      if (thumb) {
        thumbStored = path.join('thumbs', `${id}.jpg`);
        fs.mkdirSync(path.dirname(absolute(thumbStored)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(absolute(thumbStored), thumb, { mode: 0o600 });
      }
      db.prepare('UPDATE receipts SET stored_path = ?, thumb_path = ? WHERE id = ?').run(stored, thumbStored, id);
    } catch (err) {
      db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
      throw err;
    }
    kick();
    return { id, duplicate: false };
  }

  function remove(id: number) {
    const row = getRow(id);
    if (!row) return false;
    const txId = row.transaction_id;
    db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
    for (const relative of [row.stored_path, row.thumb_path]) {
      if (relative) fs.rmSync(absolute(relative), { force: true });
    }
    if (txId) bank.applyRules(`t.id = ${Number(txId)}`);
    return true;
  }

  /* ---------- Reading ---------- */

  let running: Promise<void> | null = null;

  async function readOne(id: number) {
    const row = getRow(id);
    if (!row) return 'gone';
    db.prepare(`UPDATE receipts SET status = 'reading', read_error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    try {
      const result = await reader({ data: fs.readFileSync(absolute(row.stored_path)), mime: row.mime }, categoryNames());
      const r = result.reading;
      const category = r.category && categoryNames().includes(r.category) ? r.category : null;
      // A field the user already corrected keeps their value.
      const fresh = getRow(id);
      if (!fresh) return 'gone';
      const keep = Boolean(fresh.checked);
      db.prepare(
        `UPDATE receipts SET status = 'read', read_error = ?, read_at = ?, read_model = ?, input_tokens = ?, output_tokens = ?,
           vendor = ?, receipt_date = ?, currency = ?, subtotal = ?, tax = ?, tip = ?, total = ?, card_last4 = ?, payment_method = ?,
           category = ?, items = ?, confidence = ?, reader_notes = ?, updated_at = ? WHERE id = ?`
      ).run(
        r.is_receipt ? null : "This doesn't look like a receipt.",
        now(),
        result.model,
        result.inputTokens,
        result.outputTokens,
        keep ? fresh.vendor : r.vendor?.slice(0, 120) ?? null,
        keep ? fresh.receipt_date : validDate(r.date),
        (r.currency || 'USD').toUpperCase().slice(0, 3),
        money(r.subtotal),
        keep ? fresh.tax : money(r.tax),
        keep ? fresh.tip : money(r.tip),
        keep ? fresh.total : money(r.total),
        keep ? fresh.card_last4 : (r.card_last4 || '').replace(/\D/g, '').slice(-4) || null,
        r.payment_method?.slice(0, 40) ?? null,
        keep ? fresh.category : category,
        JSON.stringify(r.items.slice(0, 200).map((i) => ({ description: i.description.slice(0, 200), quantity: i.quantity, unitPrice: money(i.unit_price), amount: money(i.amount) }))),
        r.confidence,
        r.notes?.slice(0, 500) ?? null,
        now(),
        id
      );
      if (!fresh.transaction_id) autoMatch(id);
      else bank.applyRules(`t.id = ${Number(fresh.transaction_id)}`);
      return 'read';
    } catch (err) {
      const message = (err as Error).message;
      // No key, a busy service or a network problem: try again later. Anything else: a person looks.
      const later = !(err instanceof ReaderError) || /API key in Settings|busy|tried again later/.test(message);
      db.prepare(`UPDATE receipts SET status = ?, read_error = ?, updated_at = ? WHERE id = ?`).run(later ? 'pending' : 'failed', message.slice(0, 500), now(), id);
      if (!(err instanceof ReaderError)) console.error(`Reading receipt ${id} failed:`, err);
      return later ? 'later' : 'failed';
    }
  }

  // Reads waiting receipts one at a time. Stops at the first "try later".
  function kick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      const tried = new Set<number>();
      for (;;) {
        const next = db.prepare(`SELECT id FROM receipts WHERE status = 'pending' ORDER BY id`).all().map((r) => (r as Row).id as number).find((id) => !tried.has(id));
        if (!next) break;
        tried.add(next);
        if ((await readOne(next)) === 'later') break;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function readAgain(id: number) {
    const row = getRow(id);
    if (!row) return false;
    db.prepare(`UPDATE receipts SET status = 'pending', read_error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    kick();
    return true;
  }

  /* ---------- Editing ---------- */

  function update(id: number, edit: ReceiptEdit) {
    const row = getRow(id);
    if (!row) return null;
    const fields: [string, unknown][] = [];
    if ('vendor' in edit) fields.push(['vendor', edit.vendor?.trim().slice(0, 120) || null]);
    if ('date' in edit) fields.push(['receipt_date', validDate(edit.date)]);
    if ('total' in edit) fields.push(['total', money(edit.total)]);
    if ('tax' in edit) fields.push(['tax', money(edit.tax)]);
    if ('tip' in edit) fields.push(['tip', money(edit.tip)]);
    if ('cardLast4' in edit) fields.push(['card_last4', (edit.cardLast4 || '').replace(/\D/g, '').slice(-4) || null]);
    if ('category' in edit) fields.push(['category', edit.category || null]);
    if ('note' in edit) fields.push(['note', edit.note?.trim().slice(0, 1000) || null]);
    fields.push(['checked', edit.checked === false ? 0 : 1]);
    // Someone filled it in by hand, so it no longer waits on the reader.
    if (row.status !== 'read' && ('total' in edit || 'vendor' in edit)) fields.push(['status', 'read'], ['read_error', null]);
    fields.push(['updated_at', now()]);
    db.prepare(`UPDATE receipts SET ${fields.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(fields.map(([, v]) => v) as (string | number | null)[]), id);
    const after = getRow(id)!;
    if (after.transaction_id) bank.applyRules(`t.id = ${Number(after.transaction_id)}`);
    else autoMatch(id);
    return get(id);
  }

  /* ---------- Matching ---------- */

  // Transactions this receipt might be, best first.
  function suggestions(id: number) {
    const row = getRow(id);
    if (!row || row.total === null) return [];
    const cents = toCents(row.total);
    const date = row.receipt_date as string | null;
    const rows = db
      .prepare(
        `SELECT t.*, a.name AS account_name, a.last4 AS account_last4 FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.kind != 'transfer' AND t.amount < 0
           AND -CAST(ROUND(t.amount * 100) AS INTEGER) BETWEEN ? AND ?
           ${date ? 'AND t.posted BETWEEN ? AND ?' : ''}
           AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id AND r.id != ?)
         ORDER BY t.posted DESC LIMIT 50`
      )
      // A restaurant charge can be higher than the receipt when the tip was written in.
      .all(cents, Math.round(cents * (row.tip === null ? 1.3 : 1)), ...(date ? [shift(date, -3), shift(date, 10)] : []), id) as Row[];
    return rows
      .map((t) => {
        const exact = -toCents(t.amount) === cents;
        const vendorMatch = row.vendor ? similarDescriptions(row.vendor, t.payee || t.description) || similarDescriptions(row.vendor, t.description) : false;
        const cardMatch = Boolean(row.card_last4 && t.account_last4 && row.card_last4 === t.account_last4);
        const days = date ? Math.abs(dayNumber(t.posted) - dayNumber(date)) : 30;
        // The right payee counts for more than the exact amount: $40 charges are common.
        const score = (vendorMatch ? 40 : 0) + (exact ? 30 : 0) + (cardMatch ? 20 : 0) + Math.max(0, 15 - days * 2);
        return {
          id: t.id as number,
          posted: t.posted as string,
          amount: t.amount as number,
          payee: (t.payee || t.description) as string,
          account: t.account_name as string,
          exact,
          vendorMatch,
          cardMatch,
          days,
          score,
        };
      })
      .filter((s) => s.exact || s.vendorMatch)
      .sort((a, b) => b.score - a.score);
  }

  // Links a receipt when one transaction is clearly it.
  function autoMatch(id: number) {
    const row = getRow(id);
    // A receipt the user unlinked by hand isn't matched again on its own.
    if (!row || row.transaction_id || row.status !== 'read' || row.match_source === 'user') return null;
    // The same amount and day alone isn't enough (two $40 charges happen); the vendor
    // or the card must agree too, unless the receipt names no vendor at all.
    const exact = suggestions(id).filter((s) => s.exact);
    const list = exact.filter((s) => s.vendorMatch || s.cardMatch || (!row.vendor && s.days <= 3));
    const best = list[0];
    if (!best) return null;
    const clear = list.length === 1 || (best.vendorMatch && best.score - (list[1]?.score ?? 0) >= 20);
    if (!clear) return null;
    link(id, best.id, 'auto');
    return best.id;
  }

  // After new transactions arrive, receipts that were waiting for them are matched.
  function matchUnlinked() {
    let linked = 0;
    for (const r of db.prepare(`SELECT id FROM receipts WHERE transaction_id IS NULL AND status = 'read' AND total IS NOT NULL`).all() as Row[]) {
      if (autoMatch(r.id)) linked++;
    }
    return linked;
  }

  function link(id: number, transactionId: number, source: 'auto' | 'user') {
    const row = getRow(id);
    if (!row) throw new Error('That receipt was not found.');
    if (!bank.transactionById(transactionId)) throw new Error('That transaction was not found.');
    const taken = db.prepare('SELECT id FROM receipts WHERE transaction_id = ? AND id != ?').get(transactionId, id) as Row | undefined;
    if (taken) throw new Error('Another receipt is already attached to that transaction.');
    const before = row.transaction_id;
    db.prepare('UPDATE receipts SET transaction_id = ?, match_source = ?, updated_at = ? WHERE id = ?').run(transactionId, source, now(), id);
    bank.applyRules(`t.id IN (${[transactionId, before].filter(Boolean).map(Number).join(',')})`);
  }

  function unlink(id: number) {
    const row = getRow(id);
    if (!row?.transaction_id) return false;
    // Unlinked by hand, so it isn't matched again automatically.
    db.prepare(`UPDATE receipts SET transaction_id = NULL, match_source = 'user', checked = 1, updated_at = ? WHERE id = ?`).run(now(), id);
    bank.applyRules(`t.id = ${Number(row.transaction_id)}`);
    return true;
  }

  // A purchase with no card or bank record (cash, say) becomes a transaction of its own.
  function recordCash(id: number, username: string | null) {
    const row = getRow(id);
    if (!row) throw new Error('That receipt was not found.');
    if (row.transaction_id) throw new Error('This receipt is already attached to a transaction.');
    if (row.total === null || !row.receipt_date) throw new Error('Fill in the date and total first.');
    let cashId = Number(bank.getSetting(CASH_SETTING)) || null;
    if (!cashId || !bank.account(cashId)) {
      cashId = bank.createAccount({ name: 'Cash', kind: 'other', owner: 'mixed' });
      bank.setSetting(CASH_SETTING, String(cashId));
    }
    bank.importTransactions(cashId, 'receipt', [{ externalId: `receipt-${id}-${crypto.randomUUID().slice(0, 8)}`, posted: row.receipt_date, amount: -Math.abs(row.total), description: row.vendor || 'Cash purchase' }], {
      fileName: `Receipt ${id}`,
      username,
    });
    const txId = (db.prepare(`SELECT transaction_id FROM bank_tx_sources WHERE account_id = ? AND source = 'receipt' AND external_id LIKE ? ORDER BY rowid DESC`).get(cashId, `receipt-${id}-%`) as Row).transaction_id;
    link(id, txId, 'user');
    return txId as number;
  }

  // Where a receipt sits in a filtered list, for stepping through them one by one:
  // the ones either side, and the next one not checked yet (wrapping round to the
  // start). A receipt that isn't in the list starts from the top.
  function neighbours(filters: ReceiptFilters, id: number) {
    const { receipts: all } = list(filters, Number.MAX_SAFE_INTEGER, 0);
    const at = all.findIndex((r) => r.id === id);
    const others = at < 0 ? all : [...all.slice(at + 1), ...all.slice(0, at)];
    return {
      position: at < 0 ? null : at + 1,
      total: all.length,
      prev: at > 0 ? all[at - 1].id : null,
      next: at >= 0 && at < all.length - 1 ? all[at + 1].id : null,
      nextToCheck: others.find((r) => !r.checked)?.id ?? null,
      toCheck: all.filter((r) => !r.checked && r.id !== id).length,
    };
  }

  return { add, get, list, neighbours, choices, counts, update, remove, filePath, thumbPath, readAgain, kick, suggestions, autoMatch, matchUnlinked, link, unlink, recordCash, keyStatus, setApiKey, apiKey };
}

export type ReceiptService = ReturnType<typeof receiptService>;

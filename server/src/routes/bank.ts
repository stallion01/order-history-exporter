// Bank and card accounts, transactions, imports, exports, rules and SimpleFIN.
// Signed-in users only.
import { INCOME_SOURCE_NAMES } from '../bank/merchant';
import type { IncomeSource } from '../bank/merchant';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { applyMapping, guessMapping, layoutSignature, readTable } from '../bank/csv';
import type { CsvMapping } from '../bank/csv';
import { looksLikeOfx, parseOfx, writeOfx } from '../bank/ofx';
import type { SimplefinService } from '../bank/simplefin';
import { IMPORT_OUTCOMES } from '../bank/store';
import type { BankStore, ImportOutcome, TxFilters } from '../bank/store';
import { ACCOUNT_KINDS, OWNERS, TX_KINDS, TX_STATUSES } from '../bank/types';
import { core } from '../legacy';
import { HttpError, dateParam, queryOf } from '../params';
import type { Query } from '../params';
import type { AuthedRequest } from '../app';

const MAX_FILE_CHARS = 15 * 1024 * 1024;
const YEAR = /^\d{4}$/;
const KIND_LABELS: Record<string, string> = { normal: 'Spending or income', transfer: 'Transfer', ignored: 'Ignored' };
const STATUS_LABELS: Record<string, string> = { business: 'Business', personal: 'Personal' };

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

const sourceOf = (value: string | null): IncomeSource | null => {
  if (!value) return null;
  if (!INCOME_SOURCE_NAMES.includes(value as IncomeSource)) throw new HttpError(400, 'Unknown income source.');
  return value as IncomeSource;
};

export function txFiltersFrom(query: Query): TxFilters {
  const years = query.getAll('years').filter(Boolean);
  if (years.some((y) => !YEAR.test(y))) throw new HttpError(400, 'years must look like 2025.');
  const account = query.getAll('account').filter(Boolean).map(Number);
  if (account.some((n) => !Number.isInteger(n))) throw new HttpError(400, 'Unknown account.');
  const kind = query.get('kind') || 'normal';
  if (![...TX_KINDS, 'all'].includes(kind as never)) throw new HttpError(400, 'Unknown type.');
  const status = query.get('status') || null;
  if (status && ![...TX_STATUSES, 'none', 'notpersonal'].includes(status as never)) throw new HttpError(400, 'Unknown status.');
  const direction = query.get('direction');
  const importId = query.get('import') ? Number(query.get('import')) : null;
  if (importId !== null && !Number.isInteger(importId)) throw new HttpError(400, 'Unknown import.');
  const outcome = query.get('outcome') || null;
  if (outcome && !IMPORT_OUTCOMES.includes(outcome as ImportOutcome)) throw new HttpError(400, 'Unknown outcome.');
  return {
    from: dateParam(query.get('from'), 'from'),
    to: dateParam(query.get('to'), 'to'),
    years: years.length ? years : null,
    account: account.length ? account : null,
    category: query.getAll('category').filter(Boolean).length ? query.getAll('category').filter(Boolean) : null,
    status,
    kind,
    direction: direction === 'in' || direction === 'out' ? direction : null,
    source: sourceOf(query.get('source')),
    q: query.get('q') || null,
    review: query.get('review') === '1',
    importId,
    importOutcome: outcome as ImportOutcome | null,
    entity: query.getAll('entity').filter(Boolean).length ? query.getAll('entity').filter(Boolean).map((e) => (e === 'none' ? e : Number(e))) : null,
    storeUnlinked: query.get('unmatched') === '1',
  };
}

const csvCell = (value: unknown) => core.csvCell(value);
const rowsToCsv = (rows: unknown[][]) => `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
const send = (reply: FastifyReply, type: string, filename: string, body: string) =>
  reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${filename}"`).header('Cache-Control', 'no-store').send(body);

const mappingSchema = z.object({
  date: z.number().int().min(0),
  description: z.number().int().min(0),
  amount: z.number().int().min(0).nullable(),
  debit: z.number().int().min(0).nullable(),
  credit: z.number().int().min(0).nullable(),
  memo: z.number().int().min(0).nullable(),
  reference: z.number().int().min(0).nullable(),
  flip: z.boolean(),
  direction: z.number().int().min(0).nullable().optional(),
  dateOrder: z.enum(['mdy', 'dmy', 'ymd']),
});

const fileSchema = z.object({
  fileName: z.string().max(260).optional().default(''),
  content: z.string().min(1, 'The file is empty.').max(MAX_FILE_CHARS, 'The file is too large.'),
});

const newAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  institution: z.string().trim().max(100).optional().nullable(),
  kind: z.enum(ACCOUNT_KINDS as [string, ...string[]]),
  owner: z.enum(OWNERS as [string, ...string[]]),
});

export function bankRoutes(app: FastifyInstance, bank: BankStore, simplefin: SimplefinService | null, categoryNames: () => string[], entityIds: () => number[] = () => []) {
  const checkEntity = (id: number | null | undefined) => {
    if (id && !entityIds().includes(id)) throw new HttpError(400, 'Unknown business or property.');
  };
  const user = (request: unknown) => (request as AuthedRequest).user?.username ?? null;
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const idParam = (value: unknown) => {
    const id = Number(value);
    if (!Number.isInteger(id) || !bank.account(id)) throw new HttpError(404, 'That account was not found.');
    return id;
  };
  const checkCategory = (category: string | null | undefined) => {
    if (category && !categoryNames().includes(category)) throw new HttpError(400, 'Unknown category.');
  };

  /* ---------- Accounts ---------- */

  app.get('/api/bank/accounts', async () => ({
    accounts: bank.accounts(),
    simplefin: simplefin ? simplefin.status() : null,
    reviewCount: bank.reviewCount(),
  }));

  app.post('/api/bank/accounts', async (request) => {
    const body = parse(newAccountSchema, request.body);
    const id = bank.createAccount({ ...body, kind: body.kind as never, owner: body.owner as never });
    audit(request, 'bank.account.create', { id, name: body.name });
    return bank.account(id);
  });

  app.post('/api/bank/accounts/:id', async (request) => {
    const id = idParam((request.params as { id: string }).id);
    const body = parse(newAccountSchema.partial().pick({ name: true, kind: true, owner: true }).extend({ entityId: z.number().int().nullable().optional() }), request.body);
    checkEntity(body.entityId);
    audit(request, 'bank.account.update', { id, ...body });
    return bank.updateAccount(id, body as never);
  });

  app.post('/api/bank/accounts/:id/delete', async (request) => {
    const id = idParam((request.params as { id: string }).id);
    const name = bank.account(id)?.name;
    bank.deleteAccount(id);
    audit(request, 'bank.account.delete', { id, name });
    return { ok: true };
  });

  /* ---------- Transactions ---------- */

  const sortOptions = (query: Query) => ({
    sort: query.get('sort') || 'date',
    direction: (query.get('dir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    limit: Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200),
    offset: Math.max(Number(query.get('offset')) || 0, 0),
  });

  app.get('/api/bank/transactions', async (request) => {
    const query = queryOf(request.query);
    return bank.listTransactions(txFiltersFrom(query), sortOptions(query));
  });


  // Imports whose amounts look the wrong way round, and putting them right.
  app.get('/api/bank/sign-problems', async () => ({ problems: bank.signProblems() }));
  app.post('/api/bank/sign-problems/fix', async (request) => {
    const body = parse(z.object({ keys: z.array(z.string().max(100)).max(200).optional() }), request.body ?? {});
    const result = bank.fixSignProblems(body.keys ?? null);
    audit(request, 'bank.signs.fix', result);
    return result;
  });

  app.post('/api/bank/transactions/update', async (request) => {
    const body = parse(
      z.object({
        ids: z.array(z.number().int()).min(1).max(5000),
        category: z.string().max(60).nullable().optional(),
        status: z.enum(TX_STATUSES).nullable().optional(),
        kind: z.enum(TX_KINDS).nullable().optional(),
        note: z.string().max(1000).nullable().optional(),
        entity: z.number().int().nullable().optional(),
        flipSign: z.literal(true).optional(),
        shares: z
          .array(z.object({ entityId: z.number().int(), percent: z.number().gt(0).max(100) }))
          .min(2)
          .max(20)
          .refine((s) => Math.abs(s.reduce((t, x) => t + x.percent, 0) - 100) < 0.01, 'Shares must add up to 100%.')
          .refine((s) => new Set(s.map((x) => x.entityId)).size === s.length, 'Each entity once.')
          .nullable()
          .optional(),
        // Also make a rule, so future transactions like these get the same choice.
        rule: z.object({ pattern: z.string().trim().min(3).max(100), accountId: z.number().int().nullable().optional() }).optional(),
      }),
      request.body
    );
    checkCategory(body.category);
    checkEntity(body.entity);
    for (const share of body.shares || []) checkEntity(share.entityId);
    const { ids, rule, ...changes } = body;
    const changed = bank.updateTransactions(ids, changes as never);
    let ruleId: number | null = null;
    if (rule) {
      ruleId = bank.saveRule({
        pattern: rule.pattern,
        accountId: rule.accountId ?? null,
        category: changes.category ?? null,
        status: changes.status ?? null,
        kind: changes.kind ?? null,
        entityId: changes.entity ?? null,
        // A rule shares equally; custom percentages stay on the transaction.
        sharedEntities: changes.shares ? changes.shares.map((s) => s.entityId) : null,
      });
    }
    audit(request, 'bank.transactions.update', { count: changed, ...changes, rule: rule?.pattern });
    return { changed, ruleId };
  });

  /* ---------- Rules ---------- */

  app.get('/api/bank/rules', async () => ({ rules: bank.rules(), accounts: bank.accounts().map((a) => ({ id: a.id, name: a.name })) }));

  app.post('/api/bank/rules', async (request) => {
    const body = parse(
      z
        .object({
          pattern: z.string().trim().min(3).max(100),
          accountId: z.number().int().nullable().optional(),
          category: z.string().max(60).nullable().optional(),
          status: z.enum(TX_STATUSES).nullable().optional(),
          kind: z.enum(TX_KINDS).nullable().optional(),
          entityId: z.number().int().nullable().optional(),
          sharedEntities: z.array(z.number().int()).max(20).nullable().optional(),
        })
        .refine((r) => r.category || r.status || r.kind || r.entityId || (r.sharedEntities && r.sharedEntities.length > 1), 'A rule needs a category, a business or personal choice, a type, or an entity.'),
      request.body
    );
    checkCategory(body.category);
    checkEntity(body.entityId);
    for (const id of body.sharedEntities || []) checkEntity(id);
    if (body.accountId) idParam(body.accountId);
    const id = bank.saveRule(body);
    audit(request, 'bank.rule.create', body);
    return { id };
  });

  app.post('/api/bank/rules/:id/delete', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!bank.deleteRule(id)) throw new HttpError(404, 'That rule was not found.');
    audit(request, 'bank.rule.delete', { id });
    return { ok: true };
  });

  /* ---------- Importing files ---------- */

  // What's in a file, before importing it.
  app.post('/api/bank/import/inspect', async (request) => {
    const body = parse(fileSchema.extend({ mapping: mappingSchema.optional() }), request.body);
    if (looksLikeOfx(body.content)) {
      let statements;
      try {
        statements = parseOfx(body.content);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return {
        type: 'ofx',
        statements: statements.map((s, index) => {
          const dates = s.transactions.map((t) => t.posted).sort();
          return {
            index,
            last4: s.last4,
            kind: s.kind,
            currency: s.currency,
            count: s.transactions.length,
            firstDate: dates[0] || null,
            lastDate: dates[dates.length - 1] || null,
            balance: s.balance,
            accountId: s.accountNumber ? bank.accountForFileKey(bank.fileKey(s.accountNumber)) : null,
          };
        }),
      };
    }
    let table;
    try {
      table = readTable(body.content);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const signature = layoutSignature(table.headers);
    const saved = bank.csvLayout(signature) as (CsvMapping & { accountId?: number; accountIds?: number[] }) | null;
    // A remembered layout keeps its columns, but the signs are worked out for each
    // file: a bank often exports its card and checking accounts with the same
    // headings, and only the card lists purchases as positive.
    const guess = guessMapping(table);
    const mapping: CsvMapping = body.mapping || (saved ? { ...guess, ...saved, flip: guess.flip, direction: guess.direction } : guess);
    const parsed = applyMapping(table, mapping);
    const dates = parsed.transactions.map((t) => t.posted).sort();
    // Which account: the one whose history the file overlaps, if one clearly does;
    // otherwise the account this layout was last used for, unless several share it.
    const overlap = bank.accountOverlap(parsed.transactions).filter((o) => bank.account(o.accountId));
    const best = overlap[0];
    const clear = best && best.hits >= Math.min(3, best.of) && (!overlap[1] || overlap[1].hits * 2 <= best.hits);
    const layoutAccounts = (saved?.accountIds || (saved?.accountId ? [saved.accountId] : [])).filter((id) => bank.account(id));
    const accountId = clear ? best.accountId : layoutAccounts.length === 1 ? layoutAccounts[0] : null;
    const accountReason = clear ? 'overlap' : accountId ? 'layout' : layoutAccounts.length > 1 ? 'shared-layout' : null;
    return {
      type: 'csv',
      accountReason,
      overlap: clear ? best.hits : 0,
      headers: table.headers,
      sample: table.rows.slice(0, 5),
      mapping,
      remembered: Boolean(saved),
      accountId,
      count: parsed.transactions.length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      preview: parsed.transactions.slice(0, 8),
      skipped: parsed.skipped.slice(0, 10),
      skippedCount: parsed.skipped.length,
    };
  });

  // Imports a file into an account, or with dryRun, says what importing would do.
  app.post('/api/bank/import', async (request) => {
    const body = parse(
      fileSchema.extend({
        accountId: z.number().int().optional(),
        newAccount: newAccountSchema.optional(),
        mapping: mappingSchema.optional(),
        statement: z.number().int().min(0).optional(),
        dryRun: z.boolean().optional(),
      }),
      request.body
    );
    if (!body.accountId && !body.newAccount) throw new HttpError(400, 'Choose an account, or name a new one.');

    let source: 'ofx' | 'csv';
    let transactions;
    let accountNumber: string | null = null;
    let balance: { amount: number | null; date: string | null } | null = null;
    let last4: string | null = null;
    let layout: { signature: string; mapping: CsvMapping } | null = null;
    try {
      if (looksLikeOfx(body.content)) {
        const statements = parseOfx(body.content);
        const statement = statements[body.statement ?? 0];
        if (!statement) throw new Error('That statement is not in the file.');
        source = 'ofx';
        transactions = statement.transactions;
        accountNumber = statement.accountNumber;
        last4 = statement.last4;
        balance = { amount: statement.balance, date: statement.balanceDate };
      } else {
        const table = readTable(body.content);
        const mapping = body.mapping || guessMapping(table);
        source = 'csv';
        transactions = applyMapping(table, mapping).transactions;
        layout = { signature: layoutSignature(table.headers), mapping };
      }
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (!transactions.length) throw new HttpError(400, 'No transactions were found in this file.');

    // A new account is made only for a real import; a preview uses a stand-in.
    let accountId = body.accountId ? idParam(body.accountId) : null;
    let temporary = false;
    if (!accountId && body.newAccount) {
      accountId = bank.createAccount({ ...body.newAccount, kind: body.newAccount.kind as never, owner: body.newAccount.owner as never, last4 });
      temporary = Boolean(body.dryRun);
    }
    try {
      const summary = bank.importTransactions(accountId as number, source, transactions, {
        dryRun: body.dryRun,
        fileName: body.fileName || null,
        username: user(request),
        fileKey: accountNumber ? bank.fileKey(accountNumber) : null,
        layout: layout?.signature ?? null,
      });
      if (!body.dryRun) {
        if (accountNumber) bank.rememberFileKey(accountId as number, bank.fileKey(accountNumber));
        if (balance) bank.setBalance(accountId as number, balance.amount, balance.date);
        // This bank's column layout and the accounts that use it, for its next file.
        if (layout) {
          const before = bank.csvLayout(layout.signature) as { accountIds?: number[] } | null;
          bank.saveCsvLayout(layout.signature, { ...layout.mapping, accountId, accountIds: [...new Set([...(before?.accountIds || []), accountId as number])] });
        }
        audit(request, 'bank.import', { accountId, source, fileName: body.fileName, ...summary, examples: undefined });
      }
      return { ...summary, accountId: temporary ? null : accountId };
    } finally {
      if (temporary) bank.deleteAccount(accountId as number);
    }
  });

  app.get('/api/bank/imports', async () => ({ imports: bank.imports() }));

  app.get('/api/bank/imports/:id', async (request) => {
    const found = bank.importDetail(Number((request.params as { id: string }).id));
    if (!found) throw new HttpError(404, 'That import was not found.');
    return found;
  });

  // Takes an import back out.
  app.post('/api/bank/imports/:id/undo', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new HttpError(404, 'That import was not found.');
    let result;
    try {
      result = bank.undoImport(id);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'bank.import.undo', { importId: id, ...result });
    return result;
  });

  // Puts an import in the account it should have gone to.
  app.post('/api/bank/imports/:id/move', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new HttpError(404, 'That import was not found.');
    const body = parse(z.object({ accountId: z.number().int().positive() }), request.body);
    let result;
    try {
      result = bank.moveImport(id, body.accountId, user(request));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'bank.import.move', { ...result, from: id, accountId: body.accountId });
    return result;
  });

  /* ---------- Exporting ---------- */

  app.get('/api/bank/export.csv', async (request, reply) => {
    const filters = txFiltersFrom(queryOf(request.query));
    const { transactions } = bank.listTransactions(filters, { sort: 'date', direction: 'asc' });
    const rows = [
      ['Date', 'Account', 'Payee', 'Description', 'Memo', 'Amount', 'Money Out', 'Money In', 'Category', 'Business or Personal', 'Type', 'Transfer Account', 'Note', 'Sources'],
      ...transactions.map((t) => [
        t.posted,
        t.account,
        t.payee,
        t.description,
        t.memo,
        t.amount,
        t.amount < 0 ? -t.amount : '',
        t.amount > 0 ? t.amount : '',
        t.category,
        STATUS_LABELS[t.status] || '',
        KIND_LABELS[t.kind],
        t.transferAccount,
        t.note,
        t.sources.join(' + '),
      ]),
    ];
    return send(reply, 'text/csv; charset=utf-8', 'transactions.csv', rowsToCsv(rows));
  });

  // One account's transactions as an OFX statement, for Quicken, QuickBooks and others.
  app.get('/api/bank/export.ofx', async (request, reply) => {
    const query = queryOf(request.query);
    const id = idParam(query.get('account'));
    const filters = { ...txFiltersFrom(query), account: [id], kind: 'all' };
    const { transactions } = bank.listTransactions(filters, { sort: 'date', direction: 'asc' });
    const acct = bank.account(id)!;
    const today = new Date().toISOString().slice(0, 10);
    const body = writeOfx({ id, name: acct.name, kind: acct.kind, currency: acct.currency, balance: acct.balance, balanceDate: acct.balanceDate }, transactions, today);
    const safeName = acct.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'account';
    return send(reply, 'application/x-ofx', `${safeName}.ofx`, body);
  });

  /* ---------- SimpleFIN ---------- */

  const needSimplefin = () => {
    if (!simplefin) throw new HttpError(503, 'SimpleFIN is not available on this server.');
    return simplefin;
  };

  app.post('/api/bank/simplefin/connect', async (request) => {
    const body = parse(z.object({ token: z.string().trim().min(10).max(2000) }), request.body);
    let result;
    try {
      result = await needSimplefin().connect(body.token, user(request));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'simplefin.connect', { accounts: result.accounts, added: result.added });
    return { result, status: needSimplefin().status() };
  });

  app.post('/api/bank/simplefin/sync', async (request) => {
    let result;
    try {
      result = await needSimplefin().sync(user(request));
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    audit(request, 'simplefin.sync', { accounts: result.accounts, added: result.added, errors: result.errors.length });
    return { result, status: needSimplefin().status() };
  });

  app.post('/api/bank/simplefin/disconnect', async (request) => {
    needSimplefin().disconnect();
    audit(request, 'simplefin.disconnect');
    return { status: needSimplefin().status() };
  });
}

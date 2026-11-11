// Receipts: upload, view, correct, match, and the Anthropic API key that reads them.
// Signed-in users only.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, dateParam, queryOf } from '../params';
import type { ReceiptService, ReceiptView } from '../receipts/service';
import type { AuthedRequest } from '../app';

const VIEWS: ReceiptView[] = ['all', 'review', 'unmatched', 'matched'];
const MAX_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 16;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

const base64 = z.string().max(MAX_BASE64, 'The file is too large.').regex(/^[A-Za-z0-9+/]*={0,2}$/, 'The file was not sent correctly.');
const amount = z.number().min(-1e7).max(1e7).nullable();

export function receiptRoutes(app: FastifyInstance, receipts: ReceiptService, categoryNames: () => string[]) {
  const user = (request: unknown) => (request as AuthedRequest).user?.username ?? null;
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const idOf = (request: { params: unknown }) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !receipts.get(id)) throw new HttpError(404, 'That receipt was not found.');
    return id;
  };
  const fail = (err: unknown): never => {
    throw new HttpError(400, (err as Error).message);
  };

  app.get('/api/receipts', async (request) => {
    const query = queryOf(request.query);
    const view = (query.get('view') || 'all') as ReceiptView;
    if (!VIEWS.includes(view)) throw new HttpError(400, 'Unknown view.');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 60, 1), 200);
    const offset = Math.max(Number(query.get('offset')) || 0, 0);
    return {
      ...receipts.list({ view, from: dateParam(query.get('from'), 'from'), to: dateParam(query.get('to'), 'to'), q: query.get('q') || null }, limit, offset),
      counts: receipts.counts(),
      reader: receipts.keyStatus(),
    };
  });

  app.post('/api/receipts', async (request) => {
    const body = parse(
      z.object({
        fileName: z.string().max(260).optional().nullable(),
        // A fingerprint of the original photo, so the same one isn't stored twice. Browsers
        // only offer the hashing tool over HTTPS; without it, the stored file's is used.
        originalHash: z.string().regex(/^[a-f0-9]{64}$/, 'The file was not sent correctly.').optional().nullable(),
        data: base64.min(16, 'The file is empty.'),
        thumb: base64.optional().nullable(),
      }),
      request.body
    );
    let result;
    try {
      result = receipts.add(
        { originalHash: body.originalHash || null, fileName: body.fileName || null, data: Buffer.from(body.data, 'base64'), thumb: body.thumb ? Buffer.from(body.thumb, 'base64') : null },
        user(request)
      );
    } catch (err) {
      fail(err);
    }
    if (!result!.duplicate) audit(request, 'receipt.upload', { id: result!.id, fileName: body.fileName });
    return { ...result!, receipt: receipts.get(result!.id) };
  });

  app.get('/api/receipts/:id', async (request) => {
    const id = idOf(request);
    return { receipt: receipts.get(id), suggestions: receipts.suggestions(id) };
  });

  // The stored file. Served only to signed-in users, never cached by shared caches.
  app.get('/api/receipts/:id/file', async (request, reply) => {
    const file = receipts.filePath(idOf(request));
    if (!file || !fs.existsSync(file.path)) throw new HttpError(404, 'The receipt file is missing.');
    return reply
      .header('Content-Type', file.mime)
      .header('Content-Disposition', `inline; filename="${file.name}"`)
      .header('Cache-Control', 'private, no-store')
      .send(fs.createReadStream(file.path));
  });

  app.get('/api/receipts/:id/thumb', async (request, reply) => {
    const thumb = receipts.thumbPath(idOf(request));
    if (!thumb || !fs.existsSync(thumb)) throw new HttpError(404, 'No preview.');
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=3600').send(fs.createReadStream(thumb));
  });

  app.post('/api/receipts/:id', async (request) => {
    const id = idOf(request);
    const body = parse(
      z.object({
        vendor: z.string().max(120).nullable().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        total: amount.optional(),
        tax: amount.optional(),
        tip: amount.optional(),
        cardLast4: z.string().max(8).nullable().optional(),
        category: z.string().max(60).nullable().optional(),
        note: z.string().max(1000).nullable().optional(),
        checked: z.boolean().optional(),
      }),
      request.body
    );
    if (body.category && !categoryNames().includes(body.category)) throw new HttpError(400, 'Unknown category.');
    audit(request, 'receipt.update', { id });
    return { receipt: receipts.update(id, body), suggestions: receipts.suggestions(id) };
  });

  app.post('/api/receipts/:id/read', async (request) => {
    const id = idOf(request);
    receipts.readAgain(id);
    return { receipt: receipts.get(id) };
  });

  app.post('/api/receipts/:id/link', async (request) => {
    const id = idOf(request);
    const body = parse(z.object({ transactionId: z.number().int() }), request.body);
    try {
      receipts.link(id, body.transactionId, 'user');
    } catch (err) {
      fail(err);
    }
    audit(request, 'receipt.link', { id, transactionId: body.transactionId });
    return { receipt: receipts.get(id) };
  });

  app.post('/api/receipts/:id/unlink', async (request) => {
    const id = idOf(request);
    receipts.unlink(id);
    audit(request, 'receipt.unlink', { id });
    return { receipt: receipts.get(id), suggestions: receipts.suggestions(id) };
  });

  app.post('/api/receipts/:id/cash', async (request) => {
    const id = idOf(request);
    try {
      receipts.recordCash(id, user(request));
    } catch (err) {
      fail(err);
    }
    audit(request, 'receipt.cash', { id });
    return { receipt: receipts.get(id) };
  });

  app.post('/api/receipts/:id/delete', async (request) => {
    const id = idOf(request);
    receipts.remove(id);
    audit(request, 'receipt.delete', { id });
    return { ok: true };
  });

  /* ---------- The Anthropic API key ---------- */

  app.get('/api/settings/anthropic', async () => receipts.keyStatus());

  app.post('/api/settings/anthropic', async (request) => {
    const body = parse(z.object({ apiKey: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "That doesn't look like an Anthropic API key (it starts with sk-ant-).") }), request.body);
    try {
      receipts.setApiKey(body.apiKey);
    } catch (err) {
      fail(err);
    }
    audit(request, 'anthropic.key.set');
    return receipts.keyStatus();
  });

  app.post('/api/settings/anthropic/delete', async (request) => {
    receipts.setApiKey(null);
    audit(request, 'anthropic.key.remove');
    return receipts.keyStatus();
  });
}

// Stays from Hospitable: the list, one stay, linking deposits, and the connection.
// Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, queryOf } from '../params';
import { STAY_VIEWS } from '../stays/service';
import type { StayService, StayView } from '../stays/service';
import type { AuthedRequest } from '../app';

const ID = /^[A-Za-z0-9-]{1,64}$/;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

const txBody = z.object({ transactionId: z.number().int().positive() });
// What part of a transaction is for: the stay itself, a security deposit held, or that deposit paid back.
const PURPOSE = z.enum(['stay', 'security', 'refund']);

export function stayRoutes(app: FastifyInstance, stays: StayService) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const idOf = (request: { params: unknown }) => {
    const id = String((request.params as { id: string }).id || '');
    if (!ID.test(id)) throw new HttpError(404, 'That stay was not found.');
    return id;
  };
  const fail = (err: unknown): never => {
    throw new HttpError(400, (err as Error).message);
  };

  app.get('/api/stays', async (request) => {
    const query = queryOf(request.query);
    const view = (query.get('view') || 'all') as StayView;
    if (!STAY_VIEWS.includes(view)) throw new HttpError(400, 'Unknown view.');
    const year = query.get('year') || null;
    if (year && !/^\d{4}$/.test(year)) throw new HttpError(400, 'year must look like 2026.');
    const several = (key: string, pattern: RegExp) => {
      const values = query.getAll(key).filter(Boolean);
      if (values.some((v) => !pattern.test(v))) throw new HttpError(400, `Unknown ${key}.`);
      return values.length ? values.slice(0, 50) : null;
    };
    const deposit = query.get('deposit') ? Number(query.get('deposit')) : null;
    if (deposit !== null && !Number.isInteger(deposit)) throw new HttpError(400, 'Unknown deposit.');
    const filters = {
      view,
      year,
      property: several('property', ID),
      platform: several('platform', /^[a-z]{1,20}$/),
      q: query.get('q')?.slice(0, 120) || null,
      deposit,
    };
    return { ...stays.list(filters), options: stays.options(), status: stays.status() };
  });

  // Airbnb, week by week: payouts against the deposits linked to them.
  app.get('/api/stays/airbnb-weeks', async (request) => {
    const year = queryOf(request.query).get('year') || String(new Date().getFullYear());
    if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'year must look like 2026.');
    return stays.airbnbWeeks(year);
  });

  app.get('/api/stays/conflicts', async () => ({ conflicts: stays.conflictList() }));

  app.post('/api/stays/conflicts/resolve', async (request) => {
    const body = parse(z.object({ transactionId: z.number().int().positive(), subjects: z.array(z.string().regex(/^(stay|payout):[A-Za-z0-9-]{1,64}$/)).min(1).max(20) }), request.body);
    try {
      stays.resolve(body.transactionId, body.subjects);
    } catch (err) {
      fail(err);
    }
    audit(request, 'stay.conflict.resolve', body);
    return { ok: true };
  });

  app.get('/api/stays/:id', async (request) => {
    const found = stays.get(idOf(request));
    if (!found) throw new HttpError(404, 'That stay was not found.');
    return found;
  });

  app.post('/api/stays/:id', async (request) => {
    const id = idOf(request);
    const body = parse(z.object({ note: z.string().max(2000).nullable() }), request.body);
    if (!stays.setNote(id, body.note)) throw new HttpError(404, 'That stay was not found.');
    return stays.get(id);
  });

  app.post('/api/stays/:id/link', async (request) => {
    const id = idOf(request);
    const body = parse(txBody.extend({ amount: z.number().positive().max(1e7).nullable().optional(), purpose: PURPOSE.optional() }), request.body);
    try {
      stays.linkStay(id, body.transactionId, { amount: body.amount ?? null, purpose: body.purpose });
    } catch (err) {
      fail(err);
    }
    audit(request, 'stay.link', { stay: id, ...body });
    return stays.get(id);
  });

  app.post('/api/stays/:id/unlink', async (request) => {
    const id = idOf(request);
    const { transactionId, purpose } = parse(txBody.extend({ purpose: PURPOSE.optional() }), request.body);
    stays.unlinkStay(id, transactionId, purpose);
    audit(request, 'stay.unlink', { stay: id, transactionId, purpose });
    return stays.get(id);
  });

  app.post('/api/stays/payouts/:id/link', async (request) => {
    const id = idOf(request);
    const { transactionId } = parse(txBody, request.body);
    try {
      stays.linkPayout(id, transactionId);
    } catch (err) {
      fail(err);
    }
    audit(request, 'stay.payout.link', { payout: id, transactionId });
    return { ok: true };
  });

  app.post('/api/stays/payouts/:id/unlink', async (request) => {
    const id = idOf(request);
    stays.unlinkPayout(id);
    audit(request, 'stay.payout.unlink', { payout: id });
    return { ok: true };
  });

  /* ---------- Hospitable connection ---------- */

  app.get('/api/settings/hospitable', async () => stays.status());

  app.post('/api/settings/hospitable', async (request) => {
    const body = parse(z.object({ token: z.string().trim().min(20).max(4096) }), request.body);
    let result;
    try {
      result = await stays.connect(body.token);
    } catch (err) {
      fail(err);
    }
    audit(request, 'hospitable.connect', { stays: result?.stays, errors: result?.errors.length });
    return { result, status: stays.status() };
  });

  app.post('/api/settings/hospitable/delete', async (request) => {
    stays.disconnect();
    audit(request, 'hospitable.disconnect');
    return { status: stays.status() };
  });

  app.post('/api/stays/sync', async (request) => {
    let result;
    try {
      result = await stays.sync();
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    audit(request, 'hospitable.sync', { stays: result.stays, linked: result.linked, errors: result.errors.length });
    return { result, status: stays.status() };
  });
}

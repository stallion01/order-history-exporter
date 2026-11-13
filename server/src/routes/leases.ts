// Leases: tenancies, their monthly rent and their payments. Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, queryOf } from '../params';
import { PAYMENT_PURPOSES } from '../leases/service';
import type { LeaseService } from '../leases/service';
import type { AuthedRequest } from '../app';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = z.string().regex(DATE, 'Dates look like 2026-03-01.');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const money = z.number().min(0).max(1e7);

const leaseBody = z.object({
  ref: text(40),
  entityId: z.number().int().positive().nullable().optional(),
  propertyId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable().optional(),
  unit: z.string().trim().min(1).max(60),
  tenant: z.string().trim().min(1).max(200),
  phone: text(40),
  email: text(200),
  start: date,
  end: date.nullable().optional(),
  rent: money.nullable().optional(),
  deposit: money.nullable().optional(),
  channel: text(60),
  ended: z.boolean().optional(),
  note: text(2000),
});
const paymentBody = z.object({
  date,
  amount: z.number().positive().max(1e7),
  purpose: z.enum(PAYMENT_PURPOSES),
  channel: text(60),
  note: text(500),
  verified: z.boolean().optional(),
  transactionId: z.number().int().positive().nullable().optional(),
});
const scheduleBody = z.object({
  months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), amount: money, note: text(200) })).max(120),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

export function leaseRoutes(app: FastifyInstance, leases: LeaseService) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const idOf = (request: { params: unknown }, key = 'id') => {
    const id = Number((request.params as Record<string, string>)[key]);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'That lease was not found.');
    return id;
  };
  const attempt = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
  };
  const found = (id: number) => {
    const lease = leases.get(id);
    if (!lease) throw new HttpError(404, 'That lease was not found.');
    return lease;
  };

  app.get('/api/leases', async (request) => {
    const business = queryOf(request.query).get('entity');
    return leases.list(business && /^\d+$/.test(business) ? Number(business) : null);
  });

  app.post('/api/leases', async (request) => {
    const body = parse(leaseBody, request.body);
    const id = attempt(() => leases.create(body));
    audit(request, 'lease.create', { id });
    return found(id);
  });

  app.get('/api/leases/:id', async (request) => found(idOf(request)));

  app.post('/api/leases/:id', async (request) => {
    const id = idOf(request);
    const body = parse(leaseBody, request.body);
    if (!attempt(() => leases.update(id, body))) throw new HttpError(404, 'That lease was not found.');
    audit(request, 'lease.update', { id });
    return found(id);
  });

  app.post('/api/leases/:id/delete', async (request) => {
    const id = idOf(request);
    if (!leases.remove(id)) throw new HttpError(404, 'That lease was not found.');
    audit(request, 'lease.delete', { id });
    return { ok: true };
  });

  app.post('/api/leases/:id/schedule', async (request) => {
    const id = idOf(request);
    const { months } = parse(scheduleBody, request.body);
    attempt(() => leases.setSchedule(id, months));
    audit(request, 'lease.schedule', { id, months: months.length });
    return found(id);
  });

  app.get('/api/leases/:id/candidates', async (request) => ({ transactions: leases.candidates(idOf(request)) }));

  app.post('/api/leases/:id/payments', async (request) => {
    const id = idOf(request);
    const body = parse(paymentBody, request.body);
    const paymentId = attempt(() => leases.addPayment(id, body));
    audit(request, 'lease.payment.add', { id, paymentId, purpose: body.purpose, amount: body.amount });
    return found(id);
  });

  app.post('/api/leases/:id/payments/:paymentId', async (request) => {
    const id = idOf(request);
    const paymentId = idOf(request, 'paymentId');
    const body = parse(paymentBody, request.body);
    attempt(() => leases.updatePayment(id, paymentId, body));
    audit(request, 'lease.payment.update', { id, paymentId });
    return found(id);
  });

  app.post('/api/leases/:id/payments/:paymentId/delete', async (request) => {
    const id = idOf(request);
    const paymentId = idOf(request, 'paymentId');
    if (!leases.removePayment(id, paymentId)) throw new HttpError(404, 'That payment was not found.');
    audit(request, 'lease.payment.delete', { id, paymentId });
    return found(id);
  });
}

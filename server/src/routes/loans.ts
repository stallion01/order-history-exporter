// Loans whose balance the user keeps: the balance, and the principal of each payment.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../params';
import type { LoanService } from '../loans/service';
import type { AuthedRequest } from '../app';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

export function loanRoutes(app: FastifyInstance, loans: LoanService) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const idOf = (value: unknown) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found.');
    return id;
  };
  const attempt = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  };

  app.get('/api/loans', async () => ({ loans: loans.list(), pending: loans.pending() }));

  app.post('/api/loans/:id', async (request) => {
    const id = idOf((request.params as { id: string }).id);
    const body = parse(z.object({ tracked: z.boolean(), balance: z.number().min(0).max(1e9).optional(), asOf: z.string().regex(DATE).optional(), splitAccountId: z.number().int().positive().optional() }), request.body);
    attempt(() => loans.track(id, body));
    audit(request, 'loan.track', { id, ...body });
    return { loans: loans.list(), pending: loans.pending() };
  });

  app.post('/api/loans/payments/:id/record', async (request) => {
    const id = idOf((request.params as { id: string }).id);
    const body = parse(z.object({ principal: z.number().positive().max(1e9) }), request.body);
    const result = attempt(() => loans.record(id, body.principal));
    audit(request, 'loan.payment', { transactionId: id, ...result });
    return { ...result, loans: loans.list(), pending: loans.pending() };
  });

  app.post('/api/loans/payments/:id/skip', async (request) => {
    const id = idOf((request.params as { id: string }).id);
    attempt(() => loans.skip(id));
    audit(request, 'loan.payment.skip', { transactionId: id });
    return { loans: loans.list(), pending: loans.pending() };
  });

  app.post('/api/loans/payments/:id/undo', async (request) => {
    const id = idOf((request.params as { id: string }).id);
    attempt(() => loans.undo(id));
    audit(request, 'loan.payment.undo', { transactionId: id });
    return { loans: loans.list(), pending: loans.pending() };
  });
}

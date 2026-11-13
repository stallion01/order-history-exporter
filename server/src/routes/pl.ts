// Profit and loss, and the amount invested it measures returns against. Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, queryOf } from '../params';
import type { PlPeriod, PlService } from '../pl/service';
import type { AuthedRequest } from '../app';

const settingsBody = z.object({
  entityId: z.number().int().positive().nullable().optional(),
  invested: z.number().min(0).max(1e10).nullable(),
  investedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2025-10-02.')
    .nullable(),
});

export function plRoutes(app: FastifyInstance, pl: PlService) {
  app.get('/api/pl', async (request) => {
    const value = queryOf(request.query).get('period') || String(new Date().getFullYear());
    let period: PlPeriod;
    if (value === 'ttm' || value === 'all') period = { kind: value };
    else if (/^\d{4}$/.test(value)) period = { kind: 'year', year: value };
    else throw new HttpError(400, 'period is a year, ttm or all.');
    const business = queryOf(request.query).get('entity');
    if (business && !/^\d+$/.test(business)) throw new HttpError(400, 'Unknown business.');
    return pl.report(period, business ? Number(business) : null);
  });

  // Cash flow, net worth and cash-on-cash return, for the dashboard.
  app.get('/api/pl/cashflow', async (request) => {
    const business = queryOf(request.query).get('entity');
    if (business && !/^\d+$/.test(business)) throw new HttpError(400, 'Unknown business.');
    return pl.cashFlow(business ? Number(business) : null);
  });

  app.post('/api/pl/market-value', async (request) => {
    const result = z.object({ entityId: z.number().int().positive(), value: z.number().min(0).max(1e10).nullable() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
    (request as unknown as AuthedRequest).audit('pl.marketValue', result.data);
    try {
      pl.saveMarketValue(result.data.entityId, result.data.value);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return { ok: true };
  });

  app.post('/api/pl/settings', async (request) => {
    const result = settingsBody.safeParse(request.body);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
    (request as unknown as AuthedRequest).audit('pl.settings', result.data);
    try {
      return pl.saveSettings(result.data);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
}

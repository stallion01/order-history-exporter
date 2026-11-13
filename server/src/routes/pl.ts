// Profit and loss, and the amount invested it measures returns against. Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, queryOf } from '../params';
import type { PlPeriod, PlService } from '../pl/service';
import type { AuthedRequest } from '../app';

const settingsBody = z.object({
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
    return pl.report(period);
  });

  app.post('/api/pl/settings', async (request) => {
    const result = settingsBody.safeParse(request.body);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
    (request as unknown as AuthedRequest).audit('pl.settings', result.data);
    return pl.saveSettings(result.data);
  });
}

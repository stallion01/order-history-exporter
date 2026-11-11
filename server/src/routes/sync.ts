// The Chrome extension's endpoints. Their paths and replies must not change,
// because installed copies of the extension depend on them.
import type { FastifyInstance } from 'fastify';
import type { OrdersDb } from '../legacy';
import { HttpError, dateParam, queryOf, storeParam } from '../params';

export const SYNC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/sync/plan',
  'POST /api/orders',
  'POST /api/sync/coverage',
  'POST /api/sync/runs',
]);

export function syncRoutes(app: FastifyInstance, db: OrdersDb, afterOrders: () => void = () => {}) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/sync/plan', async (request) => {
    const query = queryOf(request.query);
    return db.syncPlan(
      storeParam(query.get('store')),
      { from: dateParam(query.get('from'), 'from'), to: dateParam(query.get('to'), 'to') },
      { full: query.get('full') === '1' }
    );
  });

  app.post('/api/orders', async (request) => {
    const body = (request.body || {}) as { store?: unknown; orders?: unknown };
    if (!Array.isArray(body.orders)) throw new HttpError(400, 'orders must be a list.');
    const result = db.saveOrders(storeParam(body.store), body.orders);
    // New or changed orders may now match card charges.
    try {
      afterOrders();
    } catch (err) {
      console.error('Matching orders to charges failed:', err);
    }
    return result;
  });

  app.post('/api/sync/coverage', async (request) => {
    const body = (request.body || {}) as { store?: unknown; ranges?: unknown };
    if (!Array.isArray(body.ranges)) throw new HttpError(400, 'ranges must be a list.');
    const ranges = body.ranges.map((r: { from?: unknown; to?: unknown }) => {
      const to = dateParam(r && r.to, 'to');
      if (!to) throw new HttpError(400, 'Each range needs an end date.');
      return { from: dateParam(r.from, 'from'), to };
    });
    return { coverage: db.addCoverage(storeParam(body.store), ranges) };
  });

  app.post('/api/sync/runs', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    db.recordRun(storeParam(body.store), {
      from: dateParam(body.from, 'from'),
      to: dateParam(body.to, 'to'),
      newOrders: Number(body.newOrders) || 0,
      updatedOrders: Number(body.updatedOrders) || 0,
      detailsRead: Number(body.detailsRead) || 0,
      detailsMissed: Number(body.detailsMissed) || 0,
      complete: Boolean(body.complete),
    });
    return { ok: true };
  });
}

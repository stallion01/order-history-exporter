// Phase 4: entities, order-to-charge links, and spending split by item and entity.
// Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CorrelationService } from '../correlate/service';
import { ENTITY_ACTIVITIES, ENTITY_KINDS, ENTITY_TAX_FORMS } from '../correlate/service';
import type { BankStore } from '../bank/store';
import type { OrdersDb } from '../legacy';
import { HttpError, queryOf, storeParam, textParam } from '../params';
import { txFiltersFrom } from './bank';
import type { AuthedRequest } from '../app';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

export function correlationRoutes(app: FastifyInstance, correlate: CorrelationService, bank: BankStore, db: OrdersDb) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);
  const txOf = (request: { params: unknown }) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !bank.transactionById(id)) throw new HttpError(404, 'That transaction was not found.');
    return id;
  };
  const entityOf = (value: unknown) => {
    const id = Number(value);
    if (!correlate.entities().some((e) => e.id === id)) throw new HttpError(404, 'That business or property was not found.');
    return id;
  };

  /* ---------- Entities ---------- */

  const entitySchema = z.object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(ENTITY_KINDS),
    activity: z.enum(ENTITY_ACTIVITIES).nullable().optional(),
    taxForm: z.enum(ENTITY_TAX_FORMS).nullable().optional(),
    invested: z.number().min(0).max(1e10).nullable().optional(),
    investedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2025-10-02.')
      .nullable()
      .optional(),
  });

  app.get('/api/entities', async () => ({ entities: correlate.entities() }));

  app.post('/api/entities', async (request) => {
    const body = parse(entitySchema, request.body);
    if (correlate.entities().some((e) => e.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(409, 'There is already one with that name.');
    const id = correlate.saveEntity(body);
    audit(request, 'entity.create', { id, ...body });
    return { id, entities: correlate.entities() };
  });

  app.post('/api/entities/:id', async (request) => {
    const id = entityOf((request.params as { id: string }).id);
    const body = parse(entitySchema, request.body);
    if (correlate.entities().some((e) => e.id !== id && e.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(409, 'There is already one with that name.');
    correlate.saveEntity({ id, ...body });
    audit(request, 'entity.update', { id, ...body });
    return { entities: correlate.entities() };
  });

  app.post('/api/entities/:id/delete', async (request) => {
    const id = entityOf((request.params as { id: string }).id);
    correlate.deleteEntity(id);
    audit(request, 'entity.delete', { id });
    return { entities: correlate.entities() };
  });

  // Which entity each delivery place belongs to.
  app.post('/api/places/entity', async (request) => {
    const body = parse(z.object({ zip: z.string().trim().min(1).max(20), entityId: z.number().int().nullable() }), request.body);
    if (body.entityId) entityOf(body.entityId);
    correlate.setPlaceEntity(body.zip, body.entityId);
    audit(request, 'place.entity', body);
    return { places: db.places(), placeEntities: Object.fromEntries(correlate.placeEntities()) };
  });

  app.get('/api/places/entities', async () => ({ placeEntities: Object.fromEntries(correlate.placeEntities()) }));

  /* ---------- Orders and charges ---------- */

  // The orders a charge might be for, and how it splits by item.
  app.get('/api/bank/transactions/:id/orders', async (request) => {
    const id = txOf(request);
    const q = queryOf(request.query).get('q');
    return { suggestions: correlate.orderSuggestions(id, q ? q.slice(0, 100) : null), split: correlate.splitOf(id) };
  });

  const linkSchema = z.object({ store: z.string(), orderId: z.string().min(1).max(200) });

  app.post('/api/bank/transactions/:id/orders/link', async (request) => {
    const id = txOf(request);
    const body = parse(linkSchema, request.body);
    try {
      correlate.linkByUser(id, storeParam(body.store), body.orderId);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'order.link', { transactionId: id, ...body });
    return { suggestions: correlate.orderSuggestions(id), split: correlate.splitOf(id) };
  });

  app.post('/api/bank/transactions/:id/orders/unlink', async (request) => {
    const id = txOf(request);
    const body = parse(linkSchema, request.body);
    correlate.unlink(id, storeParam(body.store), body.orderId);
    audit(request, 'order.unlink', { transactionId: id, ...body });
    return { suggestions: correlate.orderSuggestions(id), split: correlate.splitOf(id) };
  });

  app.post('/api/bank/match-orders', async (request) => {
    const linked = correlate.matchOrders();
    audit(request, 'order.match', { linked });
    return { linked };
  });

  app.get('/api/orders/:store/:orderId/charges', async (request) => {
    const params = request.params as { store: string; orderId: string };
    return { charges: correlate.chargesFor(storeParam(params.store), textParam(params.orderId, 'Order', 200)) };
  });

  /* ---------- Spending ---------- */

  app.get('/api/bank/spending', async (request) => correlate.spending(txFiltersFrom(queryOf(request.query))));
}

// Phase 5: the year-end package and the asset register. Signed-in users only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { buildPackage, buildPdf, buildWorkbook } from '../cpa/documents';
import type { YearData } from '../cpa/documents';
import { DE_MINIMIS, RECOVERY_PERIODS } from '../cpa/service';
import type { CpaService } from '../cpa/service';
import type { CorrelationService } from '../correlate/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
  }
  return result.data;
}

const RECOVERY = RECOVERY_PERIODS.map(([years]) => years) as [string, ...string[]];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function cpaRoutes(app: FastifyInstance, cpa: CpaService, correlate: CorrelationService) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);

  // ?year=2026&entity=3 (or entity=none for spending not assigned to one).
  const scopeOf = (request: { query: unknown }) => {
    const query = queryOf(request.query);
    const year = Number(query.get('year'));
    if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new HttpError(400, 'Choose a year.');
    const raw = query.get('entity');
    let entityId: number | 'none' | null = null;
    let scope = 'All businesses and properties';
    if (raw === 'none') {
      entityId = 'none';
      scope = 'Spending not assigned to a business or property';
    } else if (raw) {
      const entity = correlate.entities().find((e) => e.id === Number(raw));
      if (!entity) throw new HttpError(404, 'That business or property was not found.');
      entityId = entity.id;
      scope = entity.name;
    }
    return { year, entityId, scope };
  };

  const yearData = (year: number, entityId: number | 'none' | null, scope: string): YearData => ({
    year,
    scope,
    generated: new Date(),
    summary: cpa.summary(year, entityId),
    lines: cpa.yearLines(year, entityId),
    income: cpa.income(year, entityId),
    transfers: entityId === null ? cpa.transfers(year) : [],
    assets: cpa.assets(year).filter((a) => entityId === null || (entityId === 'none' ? a.entityId === null : a.entityId === entityId)),
    review: cpa.review(year),
    possibleCapital: cpa.possibleCapital(year),
  });

  const send = (reply: FastifyReply, type: string, name: string, body: Buffer) =>
    reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${name}"`).header('Cache-Control', 'no-store').send(body);
  const slug = (scope: string) => (scope.startsWith('All ') ? '' : ` ${scope.replace(/[^a-z0-9]+/gi, ' ').trim()}`);

  app.get('/api/cpa/summary', async (request) => {
    const { year, entityId } = scopeOf(request);
    return {
      summary: cpa.summary(year, entityId),
      review: cpa.review(year),
      possibleCapital: cpa.possibleCapital(year),
      assets: cpa.assets(year),
      deMinimis: DE_MINIMIS,
      recoveryPeriods: RECOVERY_PERIODS,
    };
  });

  app.get('/api/cpa/workbook.xlsx', async (request, reply) => {
    const { year, entityId, scope } = scopeOf(request);
    audit(request, 'cpa.workbook', { year, entityId });
    return send(reply, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `Business Hub ${year}${slug(scope)}.xlsx`, await buildWorkbook(yearData(year, entityId, scope)));
  });

  app.get('/api/cpa/summary.pdf', async (request, reply) => {
    const { year, entityId, scope } = scopeOf(request);
    audit(request, 'cpa.pdf', { year, entityId });
    return send(reply, 'application/pdf', `Year-end summary ${year}${slug(scope)}.pdf`, await buildPdf(yearData(year, entityId, scope)));
  });

  app.get('/api/cpa/package.zip', async (request, reply) => {
    const { year, entityId, scope } = scopeOf(request);
    const data = yearData(year, entityId, scope);
    // Receipts for the year; for one entity, those attached to its transactions.
    const wanted = new Set(data.lines.map((l) => l.receiptId).filter(Boolean));
    const receipts = cpa.yearReceipts(year).filter((r) => entityId === null || wanted.has(r.id));
    audit(request, 'cpa.package', { year, entityId, receipts: receipts.length });
    return send(reply, 'application/zip', `CPA package ${year}${slug(scope)}.zip`, await buildPackage(data, receipts));
  });

  /* ---------- Assets and possible capital purchases ---------- */

  const assetSchema = z.object({
    description: z.string().trim().min(1).max(200).optional(),
    cost: z.number().positive().max(1e9).optional(),
    placedInService: date.optional(),
    entityId: z.number().int().nullable().optional(),
    recovery: z.enum(RECOVERY).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  });
  const checkEntity = (id: number | null | undefined) => {
    if (id && !correlate.entities().some((e) => e.id === id)) throw new HttpError(400, 'Unknown business or property.');
  };

  app.get('/api/assets', async () => ({ assets: cpa.assets(), recoveryPeriods: RECOVERY_PERIODS }));

  app.post('/api/assets', async (request) => {
    const body = parse(assetSchema.extend({ transactionId: z.number().int().optional() }), request.body);
    checkEntity(body.entityId);
    let id;
    try {
      id = cpa.addAsset(body);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'asset.create', { id, ...body });
    return { id, assets: cpa.assets() };
  });

  app.post('/api/assets/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    const body = parse(assetSchema, request.body);
    checkEntity(body.entityId);
    if (!cpa.updateAsset(id, body)) throw new HttpError(404, 'That asset was not found.');
    audit(request, 'asset.update', { id, ...body });
    return { assets: cpa.assets() };
  });

  app.post('/api/assets/:id/delete', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!cpa.deleteAsset(id)) throw new HttpError(404, 'That asset was not found.');
    audit(request, 'asset.delete', { id });
    return { assets: cpa.assets() };
  });

  const keySchema = z.object({ key: z.string().regex(/^(tx|item):\d+(:.*)?$/).max(500), recovery: z.enum(RECOVERY).nullable().optional(), description: z.string().max(200).nullable().optional() });

  app.post('/api/cpa/capital/confirm', async (request) => {
    const body = parse(keySchema, request.body);
    let id;
    try {
      id = cpa.confirmCapital(body.key, body);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(request, 'capital.confirm', { key: body.key, id });
    return { id };
  });

  app.post('/api/cpa/capital/dismiss', async (request) => {
    const body = parse(keySchema.pick({ key: true }), request.body);
    cpa.dismissCapital(body.key);
    audit(request, 'capital.dismiss', body);
    return { ok: true };
  });
}

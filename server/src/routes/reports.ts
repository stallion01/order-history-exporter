// Reports, items, categories and tax groups for the web app. Signed-in users only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FORMS, cents, core } from '../legacy';
import type { OrdersDb } from '../legacy';
import {
  HttpError,
  RULE_FIELDS,
  SIMPLE_FIELDS,
  STATUSES,
  filtersFrom,
  formParam,
  lineParam,
  pageFrom,
  queryOf,
  sortFrom,
  storeParam,
  taxFilters,
  textParam,
} from '../params';
import type { AuthedRequest } from '../app';

const STATUS_LABELS: Record<string, string> = { business: 'Business', personal: 'Personal', unreviewed: 'Not reviewed' };

function sendCsv(reply: FastifyReply, filename: string, body: string) {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Cache-Control', 'no-store')
    .send(body);
}

const rowsToCsv = (rows: unknown[][]) => `﻿${rows.map((row) => row.map(core.csvCell).join(',')).join('\r\n')}\r\n`;

function itemRows(items: any[], form: string): unknown[][] {
  const lineKey = form === 'schedule-e' ? 'scheduleE' : 'scheduleC';
  const labels = new Map(FORMS[form].lines);
  return [
    ['Order Date', 'Store', 'Order ID', 'Item', 'Category', 'Quantity', 'Item Price', 'Amount Paid', 'Amount Is Estimated', 'Delivery ZIP', 'Delivery Address', 'Payment Method', 'Business or Personal', `${FORMS[form].name} Line`, 'Line Description', 'Item URL', 'Order URL'],
    ...items.map((item) => [
      item.date,
      item.storeName,
      item.orderId,
      item.name,
      item.category,
      item.quantity,
      item.price,
      item.amount,
      item.estimated ? 'Yes' : 'No',
      item.deliveryZip,
      item.deliveryAddress,
      item.payment,
      STATUS_LABELS[item.status],
      item[lineKey],
      labels.get(item[lineKey]) || '',
      item.url,
      item.orderUrl,
    ]),
  ];
}

// rulesChanged: bank charges follow the business and personal rules too.
export function reportRoutes(app: FastifyInstance, db: OrdersDb, rulesChanged: () => void = () => {}) {
  const audit = (request: unknown, action: string, detail?: unknown) => (request as AuthedRequest).audit(action, detail);

  app.get('/api/status', async () => db.status());

  app.get('/api/report', async (request) => db.report(filtersFrom(queryOf(request.query))));

  // Each delivery ZIP's place name: found from its addresses, or named by the user.
  app.get('/api/places', async () => ({ places: db.places() }));

  app.post('/api/places', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const zip = textParam(body.zip, 'ZIP', 20);
    const name = typeof body.name === 'string' && body.name.trim() ? textParam(body.name, 'Name', 60) : null;
    db.nameZip(zip, name);
    audit(request, 'place.name', { zip, name });
    return { places: db.places() };
  });

  app.get('/api/orders', async (request) => {
    const query = queryOf(request.query);
    return db.listOrders(filtersFrom(query), { ...sortFrom(query), ...pageFrom(query) });
  });

  app.get('/api/items', async (request) => {
    const query = queryOf(request.query);
    return db.listItems(filtersFrom(query), { ...sortFrom(query), ...pageFrom(query) });
  });

  app.get('/api/categories', async () => ({
    categories: db.categoryList(),
    forms: Object.fromEntries(Object.entries(FORMS).map(([id, form]) => [id, { name: form.name, lines: form.lines }])),
  }));

  app.post('/api/categories', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const category = {
      name: textParam(body.name, 'Category name', 60),
      scheduleC: lineParam('schedule-c', body.scheduleC),
      scheduleE: lineParam('schedule-e', body.scheduleE),
      // Left out, the partnership form lines stay as they were.
      form1065: body.form1065 === undefined ? undefined : lineParam('form-1065', body.form1065),
      form8825: body.form8825 === undefined ? undefined : lineParam('form-8825', body.form8825),
      // Operating expense, or cost of goods sold (things bought to resell or make products from).
      expenseClass: body.expenseClass === 'cogs' || body.expenseClass === 'opex' ? (body.expenseClass as 'opex' | 'cogs') : null,
    };
    db.saveCategory(category);
    audit(request, 'category.save', category);
    return { categories: db.categoryList() };
  });

  app.post('/api/items/category', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const name = textParam(body.name, 'Item name', 1000);
    if (body.category === null || body.category === '') {
      db.setItemCategory(name, null);
    } else {
      const category = textParam(body.category, 'Category', 60);
      if (!db.categoryList().some((c) => c.name === category)) throw new HttpError(400, 'Unknown category.');
      db.setItemCategory(name, category);
    }
    audit(request, 'item.category', { name, category: body.category ?? null });
    return { ok: true };
  });

  // Marks listed items, or everything matching filters, as business or personal.
  app.post('/api/items/status', async (request) => {
    const body = (request.body || {}) as Record<string, any>;
    const status = body.status === null || body.status === 'unreviewed' ? null : body.status;
    if (status !== null && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
    let items: { store: string; orderId: string; name: string }[];
    if (body.filters && typeof body.filters === 'object') {
      const entries = Object.entries(body.filters).filter(([, v]) => v !== null && v !== undefined && v !== '');
      items = db.enrichedItems(filtersFrom(queryOf(Object.fromEntries(entries))));
    } else if (Array.isArray(body.items)) {
      items = body.items.map((item: Record<string, unknown>) => ({
        store: storeParam(item.store),
        orderId: textParam(item.orderId, 'Order', 200),
        name: textParam(item.name, 'Item name', 1000),
      }));
    } else {
      throw new HttpError(400, 'items or filters are required.');
    }
    db.markItems(items, status);
    audit(request, 'item.status', { status, count: items.length });
    return { changed: items.length };
  });

  app.get('/api/tax/rules', async () => ({ rules: db.taxRules() }));

  app.post('/api/tax/rules', async (request) => {
    const body = (request.body || {}) as Record<string, any>;
    if (!RULE_FIELDS.includes(body.field)) throw new HttpError(400, 'Unknown rule field.');
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
    // At a store, anything not on a business card is personal.
    const storeCard = body.field === 'store_card';
    let value: string;
    if (body.field === 'multi') {
      // Several conditions, all of which must match: [{ field, value, not }].
      const list = Array.isArray(body.conditions) ? body.conditions : [];
      if (list.length < 2 || list.length > 8) throw new HttpError(400, 'A rule with several conditions needs 2 to 8 of them.');
      const conditions = list.map((c: Record<string, unknown>) => {
        if (!SIMPLE_FIELDS.includes(c?.field as string)) throw new HttpError(400, 'Unknown condition.');
        return { field: c.field as string, value: textParam(c.value, 'Condition value'), not: c.not === true };
      });
      value = JSON.stringify(conditions);
    } else {
      value = storeCard ? storeParam(body.value) : textParam(body.value, 'Rule value');
    }
    const rule = { field: body.field, value, status: storeCard ? 'personal' : body.status };
    db.saveTaxRule(rule);
    if (storeCard) rulesChanged();
    audit(request, 'rule.save', rule);
    return { rules: db.taxRules() };
  });

  app.post('/api/tax/rules/delete', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    if (!Number.isInteger(body.id)) throw new HttpError(400, 'A rule id is required.');
    db.deleteTaxRule(body.id as number);
    rulesChanged();
    audit(request, 'rule.delete', { id: body.id });
    return { rules: db.taxRules() };
  });

  app.get('/api/tax/report', async (request) => {
    const query = queryOf(request.query);
    return db.taxReport(formParam(query.get('form')), taxFilters(query));
  });

  /* ---------- CSV downloads ---------- */

  app.get('/api/export.csv', async (request, reply) => {
    const query = queryOf(request.query);
    const layout = query.get('layout') === 'orders' ? 'orders' : 'items';
    const { orders } = db.listOrders(filtersFrom(query), sortFrom(query));
    return sendCsv(reply, 'orders.csv', core.toCsv(orders, layout));
  });

  app.get('/api/items.csv', async (request, reply) => {
    const query = queryOf(request.query);
    const form = FORMS[query.get('form') || ''] ? (query.get('form') as string) : 'schedule-c';
    return sendCsv(reply, 'items.csv', rowsToCsv(itemRows(db.listItems(filtersFrom(query), sortFrom(query)).items, form)));
  });

  app.get('/api/tax/export.csv', async (request, reply) => {
    const query = queryOf(request.query);
    const form = formParam(query.get('form'));
    const filters = taxFilters(query);
    if (query.get('detail') === 'summary') {
      const report = db.taxReport(form, filters);
      const year = query.get('year') || 'All years';
      const rows: unknown[][] = [
        ['Tax Year', 'Form', 'Line', 'Description', 'Amount', 'Items', 'Items With Estimated Amounts', 'Note'],
        ...report.lines.map((line: any) => [year, report.formName, line.line, line.label, line.amount, line.items, line.estimated, line.note]),
        ...report.unassigned.map((entry: any) => [year, report.formName, 'Not assigned', entry.category, entry.amount, entry.items, '', 'Choose a form line for this category.']),
        [year, report.formName, 'Total', 'All business items', cents(report.totals.business), report.totals.businessItems, '', ''],
      ];
      return sendCsv(reply, 'tax-summary.csv', rowsToCsv(rows));
    }
    const items = db.enrichedItems({ ...filters, status: 'business' }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return sendCsv(reply, 'tax-items.csv', rowsToCsv(itemRows(items, form)));
  });
}

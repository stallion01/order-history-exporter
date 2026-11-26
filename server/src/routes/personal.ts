// Personal money: a summary for a month or a year with a look ahead, and budgets.
// The owner sees their own or a family member's; a family member's login sees only
// their own.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PersonalService } from '../personal/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

// Whose money a request is about: a family login is always its own person.
function personFor(request: FastifyRequest, asked: string | number | null | undefined): number | null {
  const user = (request as AuthedRequest).user!;
  if (user.role === 'member') return user.personId;
  if (asked === null || asked === undefined || asked === '' || asked === 'me') return null;
  const id = Number(asked);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Whose money?');
  return id;
}

export function personalRoutes(app: FastifyInstance, personal: PersonalService) {
  app.get('/api/personal', async (request) => {
    const query = queryOf(request.query);
    const month = query.get('month');
    const year = query.get('year');
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'A month looks like 2026-11.');
    if (year && !/^\d{4}$/.test(year)) throw new HttpError(400, 'A year looks like 2026.');
    const person = personFor(request, query.get('person'));
    if (person !== null && !personal.people().some((p) => p.id === person)) throw new HttpError(404, 'That person is not here.');
    const accounts = (query.get('accounts') || '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const summary = personal.summary({ month, year, accounts: accounts.length ? accounts : null, person });
    // A family member isn't shown who else is here.
    return (request as AuthedRequest).user!.role === 'member' ? { ...summary, people: [] } : summary;
  });

  app.post('/api/personal/budgets', async (request) => {
    const result = z.object({ group: z.string().min(1).max(40), monthly: z.number().min(0).max(1e8).nullable(), person: z.number().int().positive().nullable().optional() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'A budget is a kind of spending and an amount.');
    const person = personFor(request, result.data.person);
    try {
      const budgets = personal.setBudget(person, result.data.group, result.data.monthly);
      (request as unknown as AuthedRequest).audit('personal.budget', { ...result.data, person });
      return { budgets };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // Sorting one of their own payments into a kind of spending or income, for My money
  // only. A family login may do this for their own payments.
  app.post('/api/personal/group', async (request) => {
    const result = z
      .object({
        transactionId: z.number().int().positive(),
        group: z.string().min(1).max(40).nullable(),
        everyTime: z.boolean().optional(),
        person: z.number().int().positive().nullable().optional(),
      })
      .safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'Which payment, and which kind of spending?');
    const person = personFor(request, result.data.person);
    try {
      personal.setGroup(person, result.data.transactionId, result.data.group, result.data.everyTime ?? false);
      (request as unknown as AuthedRequest).audit('personal.group', { ...result.data, person });
      return { ok: true };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // A place that always goes in one group, no longer.
  app.post('/api/personal/rules/:id/delete', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which one?');
    const body = z.object({ person: z.number().int().positive().nullable().optional() }).safeParse(request.body ?? {});
    const person = personFor(request, body.success ? body.data.person : null);
    try {
      personal.removeGroupRule(person, id);
      (request as unknown as AuthedRequest).audit('personal.rule.delete', { id, person });
      return { rules: personal.groupRules(person) };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // A person's own name for a kind of money, or null for the usual one.
  app.post('/api/personal/names', async (request) => {
    const result = z.object({ group: z.string().min(1).max(40), name: z.string().trim().min(1).max(40).nullable(), person: z.number().int().positive().nullable().optional() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'A name is up to 40 letters.');
    const person = personFor(request, result.data.person);
    try {
      const names = personal.renameGroup(person, result.data.group, result.data.name);
      (request as unknown as AuthedRequest).audit('personal.name', { ...result.data, person });
      return { names };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // Searching a person's own payments.
  app.get('/api/personal/search', async (request) => {
    const query = queryOf(request.query);
    const text = (query.get('q') || '').slice(0, 80);
    const person = personFor(request, query.get('person'));
    if (person !== null && !personal.people().some((p) => p.id === person)) throw new HttpError(404, 'That person is not here.');
    return { results: personal.search(person, text), names: personal.groupNames(person) };
  });

  // Categories for money sent between family, and choosing one for a transfer. The
  // owner only (a family login is refused before reaching these).
  app.post('/api/personal/labels', async (request) => {
    const result = z.object({ name: z.string().trim().min(1).max(60), group: z.string().min(1).max(40) }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'A category needs a name and a kind of spending.');
    try {
      const id = personal.addLabel(result.data.name, result.data.group);
      (request as unknown as AuthedRequest).audit('personal.label.add', { id, ...result.data });
      return { id, labels: personal.labels() };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  app.post('/api/personal/family', async (request) => {
    const result = z.object({ transactionId: z.number().int().positive(), labelId: z.number().int().positive().nullable() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'Which transfer, and which category?');
    try {
      personal.setFamilyLabel(result.data.transactionId, result.data.labelId);
      (request as unknown as AuthedRequest).audit('personal.family', result.data);
      return { ok: true };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
}

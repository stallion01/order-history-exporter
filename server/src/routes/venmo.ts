// Venmo statements in My money: each person imports their own monthly CSVs from
// venmo.com, on a phone or a computer, into their own Venmo account here. A family
// login may import only into their own.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BankStore } from '../bank/store';
import { parseVenmoStatement } from '../bank/venmo';
import type { IncomingTransaction } from '../bank/types';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';
import { personFor } from './personal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// After this long without an import, My money asks for the latest statement.
export const VENMO_STALE_DAYS = 7;

// The Chrome extension's key for one person's Venmo: it can see that person's Venmo
// status and import into it, and nothing else.
export const VENMO_KEY_PREFIX = 'vsk_';
export const VENMO_KEY_ROUTES = new Set(['GET /api/personal/venmo', 'POST /api/personal/venmo/import']);
const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export function venmoKeyUser(db: DatabaseSync, key: string) {
  const row = db.prepare('SELECT person_id FROM venmo_sync_keys WHERE key_hash = ?').get(hashKey(key)) as Row | undefined;
  if (!row) return null;
  db.prepare('UPDATE venmo_sync_keys SET last_used_at = ? WHERE person_id = ?').run(new Date().toISOString(), row.person_id);
  const person = Number(row.person_id) || null;
  // Always as a family login, so it reaches only this person's own Venmo (the owner's is no person).
  return { id: 0, username: 'Venmo sync', totpEnabled: false, role: 'member' as const, personId: person };
}

export function venmoRoutes(app: FastifyInstance, db: DatabaseSync, bank: BankStore) {
  // A person's Venmo account: one made by importing, linked to them (the owner's has no person).
  const accountOf = (person: number | null) =>
    (db.prepare("SELECT id, name, file_key FROM bank_accounts WHERE institution = 'Venmo' AND person_id IS ? ORDER BY id LIMIT 1").get(person) as Row | undefined) ?? null;

  function status(person: number | null) {
    const account = accountOf(person);
    const key = db.prepare('SELECT created_at, last_used_at FROM venmo_sync_keys WHERE person_id = ?').get(person ?? 0) as Row | undefined;
    const sync = { hasKey: Boolean(key), keyMade: key?.created_at ?? null, keyUsed: key?.last_used_at ?? null };
    if (!account) return { account: null, lastImport: null, lastDate: null, staleDays: VENMO_STALE_DAYS, ...sync };
    const last = db.prepare("SELECT MAX(at) AS at FROM bank_imports WHERE account_id = ? AND source = 'venmo'").get(account.id) as Row;
    const latest = db.prepare('SELECT MAX(posted) AS posted FROM bank_transactions WHERE account_id = ?').get(account.id) as Row;
    return { account: { id: Number(account.id), name: String(account.name) }, lastImport: last.at ?? null, lastDate: latest.posted ?? null, staleDays: VENMO_STALE_DAYS, ...sync };
  }

  app.get('/api/personal/venmo', async (request) => status(personFor(request, queryOf(request.query).get('person'))));

  // A new key for the extension, shown once; any earlier one stops working.
  app.post('/api/personal/venmo/key', async (request) => {
    const body = z.object({ person: z.number().int().positive().nullable().optional() }).safeParse(request.body ?? {});
    const person = personFor(request, body.success ? body.data.person : null);
    if (person !== null && !db.prepare('SELECT 1 FROM personal_people WHERE id = ?').get(person)) throw new HttpError(404, 'That person is not here.');
    const key = `${VENMO_KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare(
      'INSERT INTO venmo_sync_keys (person_id, key_hash, created_at) VALUES (?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = NULL',
    ).run(person ?? 0, hashKey(key), new Date().toISOString());
    (request as AuthedRequest).audit('personal.venmo.key', { person });
    return { key, status: status(person) };
  });

  app.post('/api/personal/venmo/key/delete', async (request) => {
    const body = z.object({ person: z.number().int().positive().nullable().optional() }).safeParse(request.body ?? {});
    const person = personFor(request, body.success ? body.data.person : null);
    db.prepare('DELETE FROM venmo_sync_keys WHERE person_id = ?').run(person ?? 0);
    (request as AuthedRequest).audit('personal.venmo.key.delete', { person });
    return { status: status(person) };
  });

  app.post('/api/personal/venmo/import', async (request) => {
    const body = z
      .object({
        files: z
          .array(z.object({ name: z.string().max(200), content: z.string().max(2_000_000) }))
          .min(1)
          .max(36),
        person: z.number().int().positive().nullable().optional(),
      })
      .safeParse(request.body);
    if (!body.success) throw new HttpError(400, 'Pick one or more Venmo statement CSVs.');
    const person = personFor(request, body.data.person);
    const who = person === null ? null : (db.prepare('SELECT name FROM personal_people WHERE id = ?').get(person) as Row | undefined);
    if (person !== null && !who) throw new HttpError(404, 'That person is not here.');

    const statements = body.data.files.map((f) => {
      try {
        return { name: f.name, ...parseVenmoStatement(f.content) };
      } catch (err) {
        throw new HttpError(400, `${f.name}: ${(err as Error).message}`);
      }
    });
    const handles = [...new Set(statements.map((s) => s.handle).filter(Boolean))] as string[];
    if (handles.length > 1) throw new HttpError(400, `These statements are from more than one Venmo account (${handles.join(', ')}). Import each account's on its own.`);
    const handle = handles[0] ?? null;
    const key = handle ? bank.fileKey(`venmo:${handle.toLowerCase()}`) : null;

    // The statements go into this person's Venmo account, and only theirs.
    let account = accountOf(person);
    if (key) {
      const owner = bank.accountForFileKey(key);
      if (owner && owner !== account?.id) throw new HttpError(409, `Statements for ${handle} are already imported into another person's Venmo.`);
      if (account?.file_key && account.file_key !== key) throw new HttpError(409, `These statements are for ${handle}, a different Venmo account from the one already imported here.`);
    }
    let created = false;
    if (!account) {
      const id = bank.createAccount({ name: who ? `${String(who.name).split(/\s+/)[0]} Venmo` : 'Venmo', institution: 'Venmo', kind: 'other', owner: 'personal', fileKey: key });
      db.prepare('UPDATE bank_accounts SET person_id = ? WHERE id = ?').run(person, id);
      account = accountOf(person)!;
      created = true;
    } else if (key) bank.rememberFileKey(account.id, key);

    const transactions: IncomingTransaction[] = statements.flatMap((s) => s.transactions).sort((a, b) => a.posted.localeCompare(b.posted));
    const summary = transactions.length
      ? bank.importTransactions(account.id, 'venmo', transactions, {
          fileName: statements
            .map((s) => s.name)
            .join(', ')
            .slice(0, 200),
          username: (request as AuthedRequest).user?.username ?? null,
        })
      : null;
    if (!summary) {
      // A statement with nothing in it still counts as having imported.
      db.prepare("INSERT INTO bank_imports (at, username, source, file_name, account_id, added, merged, skipped, first_date, last_date) VALUES (?, ?, 'venmo', ?, ?, 0, 0, 0, NULL, NULL)").run(
        new Date().toISOString(),
        (request as AuthedRequest).user?.username ?? null,
        statements
          .map((s) => s.name)
          .join(', ')
          .slice(0, 200),
        account.id,
      );
    }
    // The balance from the newest statement.
    const newest = statements.filter((s) => s.ending !== null && s.lastDate).sort((a, b) => b.lastDate!.localeCompare(a.lastDate!))[0];
    if (newest) bank.setBalance(account.id, newest.ending, newest.lastDate);
    const paired = db
      .prepare('SELECT COUNT(*) AS n FROM bank_transactions t JOIN bank_transactions b ON b.id = t.transfer_id WHERE t.account_id = ? AND b.account_id != t.account_id')
      .get(account.id) as Row;
    const result = {
      account: { id: Number(account.id), name: String(account.name) },
      created,
      added: summary?.added ?? 0,
      skipped: summary?.skipped ?? 0,
      firstDate: summary?.firstDate ?? null,
      lastDate: summary?.lastDate ?? null,
      matchedToBank: Number(paired.n),
      leftOut: statements.flatMap((s) => s.skipped),
      unbalanced: statements.filter((s) => !s.balanced).map((s) => s.name),
    };
    (request as AuthedRequest).audit('personal.venmo.import', { person, files: statements.length, added: result.added, skipped: result.skipped });
    return { ...result, status: status(person) };
  });
}

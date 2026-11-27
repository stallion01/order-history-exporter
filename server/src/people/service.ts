// Family members: each has their own accounts and budgets in My money, and may have a
// login that sees only their own money. Managed by the owner.
import type { DatabaseSync } from 'node:sqlite';
import type { AuthStore } from '../auth';
import { HttpError } from '../params';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// makePersonal: sets an account's owner to personal and re-files its transactions, so
// a shared account given to someone counts in their budget.
export function peopleService({ db, auth, makePersonal = () => {} }: { db: DatabaseSync; auth: AuthStore; makePersonal?: (accountId: number) => void }) {
  const exists = (id: number) => {
    if (!db.prepare('SELECT 1 FROM personal_people WHERE id = ?').get(id)) throw new HttpError(404, 'That person is not here.');
  };

  // Accounts that can belong to someone: personal and shared ones, never a business's.
  function accounts() {
    return (db.prepare("SELECT id, name, institution, owner, person_id FROM bank_accounts WHERE owner != 'business' ORDER BY name COLLATE NOCASE").all() as Row[]).map((a) => ({
      id: Number(a.id),
      name: String(a.name),
      institution: a.institution ?? null,
      owner: String(a.owner),
      personId: a.person_id == null ? null : Number(a.person_id),
    }));
  }

  function list() {
    const people = db.prepare('SELECT id, name FROM personal_people ORDER BY name COLLATE NOCASE').all() as Row[];
    const owned = accounts();
    return {
      people: people.map((p) => {
        const login = db.prepare("SELECT id, username, totp_secret FROM users WHERE role = 'member' AND person_id = ?").get(p.id) as Row | undefined;
        return {
          id: Number(p.id),
          name: String(p.name),
          accounts: owned.filter((a) => a.personId === Number(p.id)).map((a) => a.id),
          login: login ? { id: Number(login.id), username: String(login.username), totpEnabled: Boolean(login.totp_secret) } : null,
        };
      }),
      accounts: owned,
    };
  }

  function add(name: string) {
    if (db.prepare('SELECT 1 FROM personal_people WHERE name = ?').get(name)) throw new HttpError(409, 'Someone with that name is already here.');
    const result = db.prepare('INSERT INTO personal_people (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  function update(id: number, change: { name?: string; accounts?: number[] }) {
    exists(id);
    if (change.name !== undefined) {
      const clash = db.prepare('SELECT id FROM personal_people WHERE name = ? AND id != ?').get(change.name, id);
      if (clash) throw new HttpError(409, 'Someone with that name is already here.');
      db.prepare('UPDATE personal_people SET name = ? WHERE id = ?').run(change.name, id);
    }
    if (change.accounts) {
      const allowed = new Set(accounts().map((a) => a.id));
      const bad = change.accounts.find((a) => !allowed.has(a));
      if (bad !== undefined) throw new HttpError(400, "A business's account can't belong to a person.");
      db.prepare('UPDATE bank_accounts SET person_id = NULL WHERE person_id = ?').run(id);
      const set = db.prepare('UPDATE bank_accounts SET person_id = ? WHERE id = ?');
      for (const account of change.accounts) set.run(id, account);
      // A family member's account is their own money: a shared one becomes personal.
      const owners = new Map(accounts().map((a) => [a.id, a.owner]));
      for (const account of change.accounts) if (owners.get(account) === 'mixed') makePersonal(account);
    }
  }

  // Their accounts go back to the owner, their budgets and login go.
  function remove(id: number) {
    exists(id);
    db.prepare('UPDATE bank_accounts SET person_id = NULL WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM personal_budgets WHERE person_id = ?').run(id);
    db.prepare("DELETE FROM users WHERE role = 'member' AND person_id = ?").run(id);
    db.prepare('DELETE FROM venmo_sync_keys WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM personal_people WHERE id = ?').run(id);
  }

  const loginOf = (id: number) => db.prepare("SELECT id, username FROM users WHERE role = 'member' AND person_id = ?").get(id) as Row | undefined;

  function addLogin(id: number, username: string, password: string) {
    exists(id);
    if (loginOf(id)) throw new HttpError(409, 'They already have a login. Reset its password instead.');
    if (auth.record(username)) throw new HttpError(409, 'That username is taken.');
    return auth.createUser(username, password, id);
  }

  function resetPassword(id: number, password: string) {
    const login = loginOf(id);
    if (!login) throw new HttpError(404, "They don't have a login.");
    auth.setPassword(Number(login.id), password);
    // A reset by the owner also clears two-factor, in case their phone was lost.
    auth.disableTotp(Number(login.id));
    return String(login.username);
  }

  function removeLogin(id: number) {
    const login = loginOf(id);
    if (!login) throw new HttpError(404, "They don't have a login.");
    db.prepare('DELETE FROM users WHERE id = ?').run(login.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(login.id);
    return String(login.username);
  }

  /* ---------- Admins: logins that see and manage everything ---------- */

  function admins() {
    return (db.prepare("SELECT id, username, totp_secret, created_at FROM users WHERE role = 'owner' ORDER BY id").all() as Row[]).map((u) => ({
      id: Number(u.id),
      username: String(u.username),
      totpEnabled: Boolean(u.totp_secret),
      createdAt: String(u.created_at),
    }));
  }
  const adminOf = (id: number) => {
    const row = db.prepare("SELECT id, username FROM users WHERE role = 'owner' AND id = ?").get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'That admin is not here.');
    return row;
  };

  function addAdmin(username: string, password: string) {
    if (auth.record(username)) throw new HttpError(409, 'That username is taken.');
    return auth.createUser(username, password, null).id;
  }

  // Your own password is changed from your own Settings, with your current one.
  function resetAdminPassword(id: number, password: string, selfId: number) {
    if (id === selfId) throw new HttpError(400, 'Change your own password in the Password card.');
    const row = adminOf(id);
    auth.setPassword(id, password);
    auth.disableTotp(id);
    return String(row.username);
  }

  function removeAdmin(id: number, selfId: number) {
    if (id === selfId) throw new HttpError(400, "You can't remove your own login.");
    const row = adminOf(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return String(row.username);
  }

  return { list, add, update, remove, addLogin, resetPassword, removeLogin, admins, addAdmin, resetAdminPassword, removeAdmin };
}

export type PeopleService = ReturnType<typeof peopleService>;

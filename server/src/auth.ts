// Passwords, two-factor codes and sessions for the owner's sign-in.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const SESSION_REFRESH_MS = 60 * 60 * 1000;
const TOTP_STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface User {
  id: number;
  username: string;
  totpEnabled: boolean;
}

/* ---------- Passwords ---------- */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------- Two-factor codes (RFC 6238, as used by authenticator apps) ---------- */

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}

// Accepts the current code or one step either side, for clock drift. Returns the
// matching step, or null. Steps at or before lastStep are refused, so a code can't be reused.
export function checkTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given))) return step;
  }
  return null;
}

export function totpUri(secret: string, username: string, issuer = 'Expense Hub'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}

/* ---------- Accounts and sessions ---------- */

const hashId = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();

export function createAuthStore(db: DatabaseSync) {
  const toUser = (row: Record<string, unknown> | undefined): User | null =>
    row ? { id: Number(row.id), username: String(row.username), totpEnabled: Boolean(row.totp_secret) } : null;

  return {
    hasUsers(): boolean {
      return Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
    },

    createUser(username: string, password: string): User {
      const result = db
        .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(password), now());
      return { id: Number(result.lastInsertRowid), username, totpEnabled: false };
    },

    // The full row, for checking a password or code. Never sent to the browser.
    record(username: string) {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, any> | undefined;
    },

    recordById(id: number) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any> | undefined;
    },

    setPassword(id: number, password: string): void {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
      // Other devices are signed out when the password changes.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    },

    setPendingTotp(id: number, secret: string | null): void {
      db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, id);
    },

    enableTotp(id: number, secret: string, step: number): void {
      db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(secret, step, id);
    },

    disableTotp(id: number): void {
      db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(id);
    },

    useTotpStep(id: number, step: number): void {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, id);
    },

    createSession(userId: number, userAgent: string | undefined): string {
      const token = crypto.randomBytes(32).toString('base64url');
      const created = new Date();
      const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
      db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(
        hashId(token),
        userId,
        created.toISOString(),
        expires.toISOString(),
        created.toISOString(),
        (userAgent || '').slice(0, 300)
      );
      return token;
    },

    // The signed-in user for a session cookie, or null. Active sessions are extended.
    sessionUser(token: string | undefined): User | null {
      if (!token) return null;
      const id = hashId(token);
      const row = db
        .prepare('SELECT s.expires_at, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?')
        .get(id) as Record<string, any> | undefined;
      if (!row) return null;
      const time = Date.now();
      if (Date.parse(row.expires_at) <= time) {
        db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(id);
        return null;
      }
      if (time - Date.parse(row.last_seen_at) > SESSION_REFRESH_MS) {
        db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(
          new Date(time).toISOString(),
          new Date(time + SESSION_DAYS * 86400000).toISOString(),
          id
        );
      }
      return toUser(row);
    },

    deleteSession(token: string | undefined): void {
      if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashId(token));
    },

    audit(username: string | null, action: string, detail?: unknown): void {
      db.prepare('INSERT INTO audit_log (at, username, action, detail) VALUES (?, ?, ?, ?)').run(
        now(),
        username,
        action,
        detail === undefined ? null : JSON.stringify(detail)
      );
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;

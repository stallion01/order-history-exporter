// Owner setup, sign-in, two-factor and the extension's access token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { checkTotp, newTotpSecret, totpUri, verifyPassword } from '../auth';
import type { AuthStore } from '../auth';
import { HttpError } from '../params';
import { Throttle, sameSecret } from '../security';
import type { AuthedRequest, TokenStore } from '../app';

export const SESSION_COOKIE = 'eh_session';
const MIN_PASSWORD = 10;
const FAILURES_ALLOWED = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const username = z.string().trim().min(1).max(60);
const password = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(200);
const code = z.string().trim().max(10);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
  return result.data;
}

export function authRoutes(app: FastifyInstance, store: AuthStore, tokens: TokenStore) {
  const throttle = new Throttle(FAILURES_ALLOWED, FAILURE_WINDOW_MS);

  function startSession(request: FastifyRequest, reply: FastifyReply, userId: number) {
    const token = store.createSession(userId, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      path: '/',
      maxAge: 30 * 86400,
    });
  }

  const signedIn = (request: FastifyRequest) => {
    const user = (request as AuthedRequest).user;
    if (!user) throw new HttpError(401, 'Please sign in.');
    return user;
  };

  app.get('/api/auth/state', async (request) => {
    const user = (request as AuthedRequest).user;
    return { setupNeeded: !store.hasUsers(), user: user ? { username: user.username, totpEnabled: user.totpEnabled } : null };
  });

  // First run only. The setup code is the access token printed by the server, so
  // someone else on the network can't claim a fresh install.
  app.post('/api/auth/setup', async (request, reply) => {
    const body = parse(z.object({ setupCode: z.string(), username, password }), request.body);
    if (store.hasUsers()) throw new HttpError(409, 'An owner account already exists. Sign in instead.');
    const key = `setup:${request.ip}`;
    if (throttle.blocked(key)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    // Copying from a terminal can bring line breaks or spaces with it; the token has none.
    if (!sameSecret(body.setupCode.replace(/\s+/g, ''), tokens.get())) {
      throttle.fail(key);
      throw new HttpError(403, "That setup code isn't right. It's the access token shown when the server starts.");
    }
    const user = store.createUser(body.username, body.password);
    store.audit(user.username, 'account.create');
    startSession(request, reply, user.id);
    return { user: { username: user.username, totpEnabled: false } };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = parse(z.object({ username, password: z.string().max(200), code: code.optional() }), request.body);
    const keys = [`ip:${request.ip}`, `user:${body.username.toLowerCase()}`];
    if (keys.some((key) => throttle.blocked(key))) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const record = store.record(body.username);
    const fail = (message: string) => {
      keys.forEach((key) => throttle.fail(key));
      store.audit(body.username, 'login.failed');
      return new HttpError(401, message);
    };
    if (!record || !verifyPassword(body.password, record.password_hash)) throw fail('That username or password is wrong.');
    if (record.totp_secret) {
      if (!body.code) return { needCode: true };
      const step = checkTotp(record.totp_secret, body.code, record.totp_last_step);
      if (step === null) throw fail("That code isn't right, or was already used. Wait for the next one.");
      store.useTotpStep(record.id, step);
    }
    keys.forEach((key) => throttle.clear(key));
    store.audit(record.username, 'login');
    startSession(request, reply, record.id);
    return { user: { username: record.username, totpEnabled: Boolean(record.totp_secret) } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    store.deleteSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (request) => {
    const user = signedIn(request);
    const body = parse(z.object({ current: z.string().max(200), next: password }), request.body);
    const record = store.recordById(user.id)!;
    if (!verifyPassword(body.current, record.password_hash)) throw new HttpError(403, 'Your current password is wrong.');
    store.setPassword(user.id, body.next);
    store.audit(user.username, 'password.change');
    return { ok: true, signedOut: true };
  });

  app.post('/api/auth/totp/start', async (request) => {
    const user = signedIn(request);
    if (user.totpEnabled) throw new HttpError(409, 'Two-factor sign-in is already on.');
    const secret = newTotpSecret();
    store.setPendingTotp(user.id, secret);
    const uri = totpUri(secret, user.username);
    return { secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  app.post('/api/auth/totp/enable', async (request) => {
    const user = signedIn(request);
    const body = parse(z.object({ code }), request.body);
    const record = store.recordById(user.id)!;
    if (!record.totp_pending) throw new HttpError(409, 'Start two-factor setup first.');
    const step = checkTotp(record.totp_pending, body.code, 0);
    if (step === null) throw new HttpError(400, "That code isn't right. Check your phone's clock and try the newest code.");
    store.enableTotp(user.id, record.totp_pending, step);
    store.audit(user.username, 'totp.enable');
    return { ok: true };
  });

  app.post('/api/auth/totp/disable', async (request) => {
    const user = signedIn(request);
    const body = parse(z.object({ password: z.string().max(200), code }), request.body);
    const record = store.recordById(user.id)!;
    if (!verifyPassword(body.password, record.password_hash)) throw new HttpError(403, 'Your password is wrong.');
    if (!record.totp_secret || checkTotp(record.totp_secret, body.code, record.totp_last_step) === null) {
      throw new HttpError(403, "That code isn't right.");
    }
    store.disableTotp(user.id);
    store.audit(user.username, 'totp.disable');
    return { ok: true };
  });

  app.get('/api/settings/token', async (request) => {
    signedIn(request);
    return { token: tokens.get() };
  });

  app.post('/api/settings/token/rotate', async (request) => {
    const user = signedIn(request);
    const token = tokens.rotate();
    store.audit(user.username, 'token.rotate');
    return { token };
  });
}

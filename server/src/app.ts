// Builds the web server: security checks, the extension's sync API, the web app's
// API, and the built web app itself.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createAuthStore } from './auth';
import { simplefinService } from './bank/simplefin';
import type { SimplefinService } from './bank/simplefin';
import { createBankStore } from './bank/store';
import { bankRoutes } from './routes/bank';
import type { SecretBox } from './secrets';
import type { User } from './auth';
import type { OrdersDb } from './legacy';
import { HttpError } from './params';
import { authRoutes, SESSION_COOKIE } from './routes/auth';
import { reportRoutes } from './routes/reports';
import { SYNC_ROUTES, syncRoutes } from './routes/sync';
import { isPrivateAddress, sameSecret } from './security';

export interface TokenStore {
  get(): string;
  rotate(): string;
}

export interface AppOptions {
  db: OrdersDb;
  tokens: TokenStore;
  // Host header values to accept, or a function that decides. Rejecting others stops
  // a malicious website reaching this server by pointing its own name at this machine.
  allowedHosts: string[] | ((host: string) => boolean);
  // Off by default, so a mistaken port-forward doesn't expose the books.
  allowAnyClient?: boolean;
  webRoot?: string;
  // Certificate and key, to serve HTTPS directly instead of through a proxy.
  tls?: { cert: Buffer; key: Buffer } | null;
  // Encrypts stored secrets. Without it, SimpleFIN can't be connected.
  secrets?: SecretBox | null;
  // For tests, in place of the network.
  fetchImpl?: typeof fetch;
}

declare module 'fastify' {
  interface FastifyInstance {
    simplefin: SimplefinService | null;
  }
}

export interface AuthedRequest extends FastifyRequest {
  user: User | null;
  audit(action: string, detail?: unknown): void;
}

// Sent with the web app's requests. Other websites can't add it without the browser
// asking this server first, which it never agrees to, so it blocks cross-site forgery.
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'expense-hub';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const isLoopback = (address: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export function buildApp(options: AppOptions): FastifyInstance {
  const { db, tokens, allowAnyClient = false } = options;
  const hostAllowed =
    typeof options.allowedHosts === 'function'
      ? options.allowedHosts
      : (host: string) => (options.allowedHosts as string[]).includes(host);
  const store = createAuthStore(db.raw);

  // Only a proxy on this same machine (such as Tailscale's) is trusted to say who the client is.
  const app = (
    options.tls
      ? Fastify({ https: options.tls, bodyLimit: MAX_BODY_BYTES, trustProxy: isLoopback, logger: false })
      : Fastify({ bodyLimit: MAX_BODY_BYTES, trustProxy: isLoopback, logger: false })
  ) as unknown as FastifyInstance;
  app.register(fastifyCookie);
  app.decorateRequest('user', null);
  app.decorateRequest('audit', function (this: FastifyRequest, action: string, detail?: unknown) {
    const user = (this as AuthedRequest).user;
    store.audit(user ? user.username : 'extension', action, detail);
  });

  app.addHook('onRequest', async (request) => {
    if (!allowAnyClient && !isPrivateAddress(request.ip)) {
      throw new HttpError(403, 'This server only accepts connections from private networks.');
    }
    if (!hostAllowed(String(request.host || '').toLowerCase())) {
      throw new HttpError(403, 'This server is not configured for that address. See OHE_PUBLIC_HOST in the README.');
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Who's calling: the extension with its token (sync endpoints only), or a signed-in user.
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const authed = request as AuthedRequest;
    const routeKey = `${request.method} ${request.routeOptions.url}`;
    const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (bearer) {
      if (!SYNC_ROUTES.has(routeKey)) throw new HttpError(403, 'The access token only works for syncing. Sign in to use the rest.');
      if (!sameSecret(bearer, tokens.get())) throw new HttpError(401, 'The access token is missing or wrong.');
      return;
    }
    authed.user = store.sessionUser(request.cookies[SESSION_COOKIE]);
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new HttpError(403, 'This request came from somewhere unexpected.');
    }
    if (routeKey.startsWith('GET /api/auth/') || routeKey.startsWith('POST /api/auth/')) return; // checked per route
    if (!authed.user) throw new HttpError(401, SYNC_ROUTES.has(routeKey) ? 'The access token is missing or wrong.' : 'Please sign in.');
  });

  app.setErrorHandler((error: Error & { status?: number; statusCode?: number }, request, reply) => {
    const status = error instanceof HttpError ? error.status : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    if (status >= 500) console.error(error);
    reply.code(status).send({ error: status >= 500 ? 'The server hit an error. See its log.' : error.message });
  });

  const bank = createBankStore(db.raw);
  const simplefin = options.secrets ? simplefinService(bank, options.secrets, options.fetchImpl) : null;
  app.decorate('simplefin', simplefin);

  syncRoutes(app, db);
  bankRoutes(app, bank, simplefin, () => db.categoryList().map((c) => c.name));
  reportRoutes(app, db);
  authRoutes(app, store, tokens);

  const webRoot = options.webRoot;
  const hasWeb = Boolean(webRoot && fs.existsSync(path.join(webRoot, 'index.html')));
  if (hasWeb) app.register(fastifyStatic, { root: webRoot as string, wildcard: false, index: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.method !== 'GET') {
      return reply.code(404).send({ error: 'Not found.' });
    }
    if (!hasWeb) return reply.code(503).type('text/plain').send('The web app has not been built. Run: npm run build');
    // Any other page is a route inside the web app.
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  return app;
}

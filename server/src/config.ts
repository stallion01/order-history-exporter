// Settings come from environment variables, so one build runs on a PC or in an LXC.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokenStore } from './app';

export interface Config {
  network: boolean;
  host: string;
  port: number;
  dataDir: string;
  publicHost: string;
  allowAnyClient: boolean;
  webRoot: string;
  tls: { cert: Buffer; key: Buffer } | null;
}

export function loadConfig(argv = process.argv, env = process.env): Config {
  const network = argv.includes('--network') || env.OHE_NETWORK === '1';
  if (Boolean(env.OHE_TLS_CERT) !== Boolean(env.OHE_TLS_KEY)) throw new Error('Set both OHE_TLS_CERT and OHE_TLS_KEY to use HTTPS.');
  return {
    tls: env.OHE_TLS_CERT ? { cert: fs.readFileSync(env.OHE_TLS_CERT), key: fs.readFileSync(env.OHE_TLS_KEY as string) } : null,
    network,
    host: env.OHE_HOST || (network ? '0.0.0.0' : '127.0.0.1'),
    port: Number(env.OHE_PORT) || 8787,
    dataDir: path.resolve(env.OHE_DATA_DIR || path.join(__dirname, '..', 'data')),
    publicHost: (env.OHE_PUBLIC_HOST || '').toLowerCase(),
    allowAnyClient: env.OHE_ALLOW_PUBLIC_CLIENTS === '1',
    webRoot: path.resolve(env.OHE_WEB_ROOT || path.join(__dirname, '..', '..', 'web', 'dist')),
  };
}

// The extension's access token, made once and kept beside the database.
export function fileTokenStore(dataDir: string): TokenStore {
  const file = path.join(dataDir, 'token');
  const write = () => {
    const token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
  };
  let token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : write();
  return {
    get: () => token,
    rotate: () => (token = write()),
  };
}

export function networkAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

export function allowedHostsFor(config: Config, addresses: string[]): string[] {
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (config.network) {
    const name = os.hostname().toLowerCase();
    for (const address of addresses) hosts.push(`${address}:${config.port}`);
    hosts.push(`${name}:${config.port}`, `${name}.local:${config.port}`);
  }
  // A proxy such as Tailscale's serves on the standard port, so the name alone is sent.
  if (config.publicHost) hosts.push(config.publicHost, `${config.publicHost}:443`);
  return hosts;
}

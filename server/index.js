// Starts the database server. Settings come from environment variables; see the README.
// Run with --network to serve other computers on your network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase } = require('./db');
const { createApp } = require('./app');

const NETWORK = process.argv.includes('--network') || process.env.OHE_NETWORK === '1';
const HOST = process.env.OHE_HOST || (NETWORK ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.OHE_PORT) || 8787;
const DATA_DIR = path.resolve(process.env.OHE_DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_HOST = (process.env.OHE_PUBLIC_HOST || '').toLowerCase();
const ALLOW_ANY_CLIENT = process.env.OHE_ALLOW_PUBLIC_CLIENTS === '1';
const TLS_CERT = process.env.OHE_TLS_CERT;
const TLS_KEY = process.env.OHE_TLS_KEY;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// The token is made once and kept beside the database, readable only by this user.
function loadToken() {
  const file = path.join(DATA_DIR, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function networkAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  console.error('Set both OHE_TLS_CERT and OHE_TLS_KEY to use HTTPS.');
  process.exit(1);
}
const tls = TLS_CERT ? { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) } : null;
const scheme = tls ? 'https' : 'http';

const token = loadToken();
const db = openDatabase(path.join(DATA_DIR, 'orders.db'));
const addresses = NETWORK ? networkAddresses() : [];
const hostname = os.hostname().toLowerCase();
const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
for (const address of addresses) allowedHosts.push(`${address}:${PORT}`);
if (NETWORK) allowedHosts.push(`${hostname}:${PORT}`, `${hostname}.local:${PORT}`);
if (PUBLIC_HOST) allowedHosts.push(PUBLIC_HOST);

const server = createApp({ db, token, allowedHosts, allowAnyClient: ALLOW_ANY_CLIENT, tls });
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is the server already running?`);
  else console.error(err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const local = `${scheme}://127.0.0.1:${PORT}`;
  const main = PUBLIC_HOST ? `https://${PUBLIC_HOST}` : addresses.length ? `${scheme}://${addresses[0]}:${PORT}` : local;
  console.log('Order History Exporter database server');
  console.log(`  Database:     ${path.join(DATA_DIR, 'orders.db')}`);
  console.log(`  Server URL:   ${main}`);
  for (const address of addresses.slice(1)) console.log(`                ${scheme}://${address}:${PORT}`);
  console.log(`  Reports page: ${local}/#token=${token}`);
  console.log(`  Access token: ${token}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    if (!tls) {
      console.warn('\nNETWORK MODE: anyone who can watch traffic on this network could read your');
      console.warn('token and orders, because this connection is not encrypted. Use it only on a');
      console.warn('network you trust, or set OHE_TLS_CERT and OHE_TLS_KEY. See the README.');
    }
    console.warn('\nIf other computers can\'t connect, allow this port through the firewall.');
  }
});

function shutDown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

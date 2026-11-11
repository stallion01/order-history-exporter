// Starts Expense Hub. See the README for settings.
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';
import { allowedHostsFor, fileTokenStore, loadConfig, networkAddresses } from './config';
import { openDatabase } from './legacy';
import { fileSecretBox } from './secrets';

const SYNC_CHECK_MS = 30 * 60 * 1000;

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const tokens = fileTokenStore(config.dataDir);
  const db = openDatabase(path.join(config.dataDir, 'orders.db'));
  const addresses = config.network ? networkAddresses() : [];
  const app = buildApp({
    db,
    tokens,
    allowedHosts: allowedHostsFor(config, addresses),
    allowAnyClient: config.allowAnyClient,
    webRoot: config.webRoot,
    tls: config.tls,
    secrets: fileSecretBox(config.dataDir),
    dataDir: config.dataDir,
  });
  // Receipts waiting from before a restart.
  app.receipts.kick();

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error(code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Is the server already running?` : err);
    process.exit(1);
  }

  const scheme = config.tls ? 'https' : 'http';
  const local = `${scheme}://127.0.0.1:${config.port}`;
  const main = config.publicHost ? `https://${config.publicHost}` : addresses.length ? `${scheme}://${addresses[0]}:${config.port}` : local;
  const setupNeeded = !db.raw.prepare('SELECT 1 FROM users LIMIT 1').get();
  console.log('Expense Hub');
  console.log(`  Database:     ${path.join(config.dataDir, 'orders.db')}`);
  console.log(`  Web app:      ${main}`);
  for (const address of addresses.slice(1)) console.log(`                ${scheme}://${address}:${config.port}`);
  console.log(`  Access token: ${tokens.get()}  (for the Chrome extension${setupNeeded ? ', and as the setup code for your first sign-in' : ''})`);
  if (!fs.existsSync(path.join(config.webRoot, 'index.html'))) console.warn('\nThe web app has not been built yet. Run: npm run build');
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.publicHost && !config.tls) {
    console.warn('\nNETWORK MODE without HTTPS: anyone who can watch this network could read your');
    console.warn('sign-in and data. Use it only on a network you trust, or put it behind Tailscale.');
  }

  // SimpleFIN once a day, when connected. Checked every half hour, so a restart or a
  // sleeping machine doesn't skip a day.
  const syncIfDue = () => {
    if (!app.simplefin?.due()) return;
    app.simplefin
      .sync('scheduled')
      .then((r) => console.log(`SimpleFIN: ${r.accounts} accounts, ${r.added} new transactions${r.errors.length ? `, problems: ${r.errors.join('; ')}` : ''}`))
      .catch((err) => console.error('SimpleFIN sync failed:', err.message));
  };
  const timer = setInterval(() => {
    syncIfDue();
    // Receipts that couldn't be read earlier (no key yet, or Anthropic busy).
    app.receipts.kick().catch((err) => console.error('Reading receipts failed:', err.message));
  }, SYNC_CHECK_MS);
  setTimeout(syncIfDue, 60 * 1000);

  const shutDown = async () => {
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
}

main();

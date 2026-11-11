// Makes a consistent copy of the database while the server keeps running, and keeps
// the most recent copies. Run nightly by the systemd timer, or by hand.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config';

const KEEP = Number(process.env.OHE_BACKUP_KEEP) || 14;

export function backup(dataDir: string, keep = KEEP): string {
  const target = path.resolve(process.env.OHE_BACKUP_DIR || path.join(dataDir, 'backups'));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(target, `orders-${stamp}.db`);
  const db = new DatabaseSync(path.join(dataDir, 'orders.db'), { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  const old = fs
    .readdirSync(target)
    .filter((name) => /^orders-.*\.db$/.test(name))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of old) fs.rmSync(path.join(target, name));
  copyReceipts(path.join(dataDir, 'receipts'), path.join(target, 'receipts'));
  return file;
}

// Receipt files never change once stored, so only new ones are copied. A receipt
// deleted in the app stays in the backup.
export function copyReceipts(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copied += copyReceipts(source, target);
    else if (entry.isFile() && !fs.existsSync(target)) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      copied++;
    }
  }
  return copied;
}

if (require.main === module) {
  console.log(`Backed up to ${backup(loadConfig().dataDir)}`);
}

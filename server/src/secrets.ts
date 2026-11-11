// Encrypts secrets kept in the database (such as the SimpleFIN access URL) with a key
// kept in its own file. A copy of the database alone can't reveal them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SecretBox {
  seal(text: string): string;
  open(sealed: string): string;
}

export function fileSecretBox(dataDir: string): SecretBox {
  const file = path.join(dataDir, 'secret.key');
  let key: Buffer | null = null;
  const getKey = () => {
    if (key) return key;
    if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    else {
      key = crypto.randomBytes(32);
      fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
    }
    if (key.length !== 32) throw new Error(`${file} is not a valid key.`);
    return key;
  };
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    open(sealed) {
      if (!sealed.startsWith('v1:')) throw new Error('Unknown secret format.');
      const raw = Buffer.from(sealed.slice(3), 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

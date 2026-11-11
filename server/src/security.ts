import crypto from 'node:crypto';

// True for this machine, private home or office networks, and VPN address ranges
// such as Tailscale's. False for the public internet.
export function isPrivateAddress(address: string | undefined): boolean {
  const ip = String(address || '').replace(/^::ffff:/i, '').toLowerCase();
  if (ip === '::1') return true;
  if (/^(fc|fd|fe[89ab])[0-9a-f]{0,2}:/.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Compares secrets without leaking their length or contents through timing.
export function sameSecret(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Counts failures per key in a sliding window, for slowing down password guessing.
export class Throttle {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  blocked(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return false;
    return entry.count >= this.limit;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

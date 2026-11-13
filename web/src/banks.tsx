// Each bank's own colours, so its accounts are easy to pick out, and a small badge in
// them. Drawn here rather than loaded from the banks' websites, so nothing is fetched.
import { cx } from './ui';

interface Brand {
  name: string;
  mark: string;
  colour: string; // the badge and the box's top edge
  ink?: string; // the mark's colour, when white wouldn't read
  stripe?: string; // a second colour under the mark
}

const BRANDS: [RegExp, Brand][] = [
  [/bank of america|\bbofa\b/i, { name: 'Bank of America', mark: 'BofA', colour: '#012169', stripe: '#e31837' }],
  [/\bchase\b|jp ?morgan/i, { name: 'Chase', mark: 'C', colour: '#117aca' }],
  [/associated bank/i, { name: 'Associated Bank', mark: 'AB', colour: '#00843d' }],
  [/wells fargo/i, { name: 'Wells Fargo', mark: 'WF', colour: '#d71e28', ink: '#ffcd41' }],
  [/capital ?one/i, { name: 'Capital One', mark: 'C1', colour: '#004977', stripe: '#d03027' }],
  [/american express|\bamex\b/i, { name: 'American Express', mark: 'AX', colour: '#006fcf' }],
  [/\bciti(bank|group)?\b/i, { name: 'Citi', mark: 'citi', colour: '#056dae', stripe: '#ee1c25' }],
  [/discover/i, { name: 'Discover', mark: 'D', colour: '#ff6000' }],
  [/u\.?s\.? bank/i, { name: 'U.S. Bank', mark: 'US', colour: '#0c2074', stripe: '#d52b1e' }],
  [/\bpnc\b/i, { name: 'PNC', mark: 'PNC', colour: '#ef7622' }],
  [/\btd bank\b/i, { name: 'TD Bank', mark: 'TD', colour: '#008a00' }],
  [/truist/i, { name: 'Truist', mark: 'T', colour: '#2e1a47' }],
  [/\bally\b/i, { name: 'Ally', mark: 'ally', colour: '#650360' }],
  [/paypal/i, { name: 'PayPal', mark: 'P', colour: '#003087', stripe: '#009cde' }],
  [/venmo/i, { name: 'Venmo', mark: 'V', colour: '#008cff' }],
];

// The bank, from its name, or failing that the account's name.
export function brandOf(institution: string | null | undefined, accountName = ''): Brand | null {
  for (const text of [institution || '', accountName]) {
    const found = BRANDS.find(([pattern]) => pattern.test(text));
    if (found) return found[1];
  }
  return null;
}

// A square badge in the bank's colours with its short mark; initials in grey when the
// bank isn't one of those above.
export function BankBadge({ institution, accountName, className }: { institution: string | null | undefined; accountName?: string; className?: string }) {
  const brand = brandOf(institution, accountName);
  const label = brand?.mark ?? initials(institution || accountName || '');
  const size = label.length > 2 ? 'text-[9px]' : 'text-[11px]';
  return (
    <span
      role="img"
      aria-label={brand?.name ?? institution ?? 'Bank'}
      title={brand?.name ?? institution ?? undefined}
      className={cx('relative inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md font-bold leading-none tracking-tight', size, !brand && 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200', className)}
      style={brand ? { background: brand.colour, color: brand.ink ?? '#fff' } : undefined}
    >
      {label}
      {brand?.stripe && <span className="absolute inset-x-0 bottom-0 h-1" style={{ background: brand.stripe }} aria-hidden />}
    </span>
  );
}

function initials(text: string) {
  const words = text.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !/^(bank|the|of|n\.?a\.?|inc|llc)$/i.test(w));
  return (words.length ? words.slice(0, 2).map((w) => w[0]) : ['?']).join('').toUpperCase();
}

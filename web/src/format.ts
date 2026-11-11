const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const wholeMoneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const wholeFormat = new Intl.NumberFormat('en-US');

export const money = (n: number | null | undefined) => (typeof n === 'number' ? moneyFormat.format(n) : '–');
export const wholeMoney = (n: number) => wholeMoneyFormat.format(n);
export const whole = (n: number | null | undefined) => (typeof n === 'number' ? wholeFormat.format(n) : '–');

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(key: string, short = false) {
  const [year, month] = key.split('-').map(Number);
  return short ? `${MONTHS[month - 1]} ${String(year).slice(2)}` : `${MONTHS[month - 1]} ${year}`;
}

export const plural = (n: number, word: string) => `${wholeFormat.format(n)} ${word}${n === 1 ? '' : 's'}`;

export function isoDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

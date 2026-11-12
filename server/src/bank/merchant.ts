// Turns bank descriptions into readable payee names, and suggests a category from
// the payee. Rules the user makes and their own edits always come first.

// Well-known merchants, whose descriptions vary a lot between banks.
const KNOWN: [RegExp, string][] = [
  [/payment\s*-?\s*thank you|thank you for your payment|autopay payment|^(online|mobile|electronic)? ?payment received/i, 'Card payment'],
  [/\bamzn\b|amazon(?!\s*web)|amazon\.com|amzn mktp/i, 'Amazon'],
  [/amazon web services|\baws\b/i, 'Amazon Web Services'],
  [/\bebay\b/i, 'eBay'],
  [/wal-?mart|wm supercenter|walmart\.com/i, 'Walmart'],
  [/sams ?club|sam's club|samsclub/i, "Sam's Club"],
  [/newegg/i, 'Newegg'],
  [/home ?depot|homedepot/i, 'Home Depot'],
  [/\blowe'?s\b/i, "Lowe's"],
  [/costco/i, 'Costco'],
  [/\btarget\b/i, 'Target'],
  [/airbnb/i, 'Airbnb'],
  [/\bvrbo\b|homeaway/i, 'Vrbo'],
  [/booking\.com|booking com\b/i, 'Booking.com'],
  [/paypal/i, 'PayPal'],
  [/venmo/i, 'Venmo'],
  [/zelle/i, 'Zelle'],
  [/apple\.com|itunes/i, 'Apple'],
  [/google/i, 'Google'],
  [/microsoft|msft/i, 'Microsoft'],
  [/comcast|xfinity/i, 'Xfinity'],
  [/verizon/i, 'Verizon'],
  [/\bat&t\b|\batt\*/i, 'AT&T'],
  [/t-mobile/i, 'T-Mobile'],
  [/\buber\s*eats\b/i, 'Uber Eats'],
  [/\buber\b/i, 'Uber'],
  [/\blyft\b/i, 'Lyft'],
  [/starbucks/i, 'Starbucks'],
  [/doordash/i, 'DoorDash'],
  [/netflix/i, 'Netflix'],
  [/spotify/i, 'Spotify'],
];

// Words banks put around the merchant's name.
const NOISE = [
  /^(pos|debit card|check ?card|visa|recurring|card)\s+(purchase|debit|pmt|payment)?\s*(authorized on \d{1,2}\/\d{1,2})?/i,
  /^purchase (authorized on|on)\s+\d{1,2}\/\d{1,2}\s*/i,
  /^(pos|ach|dda|web|ppd|ccd|debit|withdrawal|purchase|payment)\s+/i,
  /^(sq|tst|pp|sp|py|ckc|dd|in|fs)\s?\*\s*/i,
  /\s+(x{2,}|\*{2,})\d{2,}.*$/i,
  /\s+card\s+\d{4}.*$/i,
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b.*$/,
  /\s+#\s?\d+.*$/,
  /\s+\d{3,}.*$/,
  /\s+[A-Z]{2}\s*$/, // a trailing state code
];

const title = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Llc|Inc|Co|Usa|Us)\b/g, (m) => (m.length <= 3 ? m.toUpperCase() : m))
    .replace(/'S\b/g, "'s");

export function payeeFor(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  for (const [pattern, name] of KNOWN) if (pattern.test(text)) return name;
  let name = text;
  for (const noise of NOISE) {
    const next = name.replace(noise, '').trim();
    if (next.length >= 3) name = next;
  }
  name = name.replace(/[*#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = text;
  return /[a-z]/.test(name) ? name.slice(0, 60) : title(name).slice(0, 60);
}

// Stores whose orders are synced; their charges get categories from the matched
// order's items (Phase 4), so no guess is made here.
export const STORE_PAYEES = new Set(['Amazon', 'eBay', 'Walmart', "Sam's Club", 'Newegg']);

const SPENDING_HINTS: [RegExp, string][] = [
  [/home ?depot|lowe'?s|menards|ace hardware|true value/i, 'Building & Repair Materials'],
  [/electric|energy|power co|water (dept|authority|utility)|sewer|national grid|eversource|pg&e|con ?ed|duke energy|dominion|utility|utilities|gas company/i, 'Utilities'],
  [/comcast|xfinity|verizon|at&t|\batt\*|t-mobile|spectrum|charter comm|cox comm|internet|wireless|starlink/i, 'Phone & Internet'],
  [/insurance|geico|state farm|progressive|allstate|liberty mutual|lemonade|nationwide|travelers/i, 'Insurance'],
  [/\bshell\b|exxon|mobil|chevron|sunoco|citgo|speedway|valero|marathon|circle k|\bbp\b|gulf oil|fuel|gas station/i, 'Automotive & Fuel'],
  [/adobe|microsoft|google (storage|workspace|gsuite|\*)|g suite|dropbox|github|openai|anthropic|claude\.ai|amazon web services|\baws\b|zoom\.us|slack|notion|canva|quickbooks|intuit|godaddy|squarespace|wix\.com|1password|lastpass|icloud/i, 'Software & Subscriptions'],
  [/service charge|interest charge|overdraft|annual fee|finance charge|foreign transaction fee|monthly (maintenance|service) fee|\bfee\b/i, 'Bank & Card Fees'],
  [/airline|airways|delta air|united air|american air|southwest|jetblue|alaska air|spirit air|frontier air|hotel|marriott|hilton|hyatt|expedia|booking\.com|\buber\b|\blyft\b|parking|\btolls?\b|e-?zpass|amtrak/i, 'Travel'],
  [/restaurant|\bcafe\b|coffee|starbucks|dunkin|mcdonald|chipotle|doordash|grubhub|uber ?eats|pizza|\bgrill\b|diner|bistro|taqueria|sushi|burger/i, 'Meals'],
  [/facebook ads|fb ads|\bmeta ads|google ads|yelp ads|nextdoor/i, 'Advertising & Listing Fees'],
  [/airbnb|vrbo|homeaway|stripe fee|square fee|paypal fee/i, 'Platform & Merchant Fees'],
  [/\birs\b|treasury|dept of revenue|department of revenue|tax collector|property tax|\bdmv\b|license|permit/i, 'Taxes & Licenses'],
  [/cleaning|maid|janitorial|turnover|landscap|lawn care|pest control|plumb|electrician|hvac|roofing|handyman/i, 'Cleaning & Maintenance Services'],
  [/mortgage|home loan|auto loan|loan pmt|loan payment/i, 'Loan & Mortgage Payments'],
  [/\brent\b|lease/i, 'Rent & Lease'],
  [/\bcpa\b|accounting|bookkeep|attorney|law office|legal/i, 'Professional Services'],
];

// Categories that are income. Money in filed anywhere else is a refund.
export const INCOME_CATEGORIES = ['Rental Income', 'Other Income'];
export const REFUNDS = 'Refunds & Returns';

const INCOME_HINTS: [RegExp, string][] = [
  [/refund|return|reversal|credit voucher|merchandise credit/i, 'Refunds & Returns'],
  [/airbnb|vrbo|homeaway|booking\.com|booking com\b|rent payment|tenant/i, 'Rental Income'],
  [/interest (paid|earned|payment)|dividend|cash ?back|reward/i, 'Other Income'],
];

// A suggested category, or null when there's nothing to go on.
export function categoryHint(description: string, payee: string, amount: number): string | null {
  const text = `${description} ${payee}`;
  if (amount > 0) {
    for (const [pattern, category] of INCOME_HINTS) if (pattern.test(text)) return category;
    return null;
  }
  if (STORE_PAYEES.has(payee)) return null;
  for (const [pattern, category] of SPENDING_HINTS) if (pattern.test(text)) return category;
  return null;
}

// Words that show money moving between the owner's own accounts.
export const TRANSFER_WORDS = /transfer|xfer|\bpayment\b|\bpymt\b|\bpmt\b|autopay|auto pay|e-?payment|online banking|thank you|to (chk|sav|checking|savings)|from (chk|sav|checking|savings)|credit card|crd pmt|card payment/i;
// A payment received on a card, from an account that may not be connected.
// The wording banks use for a card payment, not just the word "payment" (an "AIRBNB
// PAYMENTS" deposit is income, not a card payment).
// A payment from a bank account to a credit card ("Online Banking payment to CRD 1234",
// "CHASE CREDIT CRD AUTOPAY"). The card's purchases are the spending; paying the
// card only moves money, so it's a transfer even when the card isn't connected.
export const PAID_TO_CARD =
  /payment to (crd|card|credit card)\b|\bcrd \d{4}\b|credit (card|crd) (payment|pmt|pymt|autopay|epay)|\bcard ?(payment|pmt)\b|cardmember serv|\b(applecard|apple card)\b|\b(chase|citi|capital one|discover|amex|american express|barclaycard|synchrony)\b.*\b(payment|pmt|pymt|autopay|epay)\b/i;
// The card number in such a payment, so payments to "ACCT# 1234" are recognised too.
export const CARD_NUMBER_IN_PAYMENT = /payment to (?:crd|card|credit card)\s*#?\s*(\d{4})\b/i;
export const ACCOUNT_NUMBER_IN_PAYMENT = /payment to acct\s*#?\s*(\d{4})\b/i;

export const CARD_PAYMENT_WORDS = /payment\s*-?\s*thank you|thank you for your payment|\bautopay\b|auto pay|\b(online|mobile|electronic|internet|web|ach|e-?)\s?payment\b(?!s)|payment received|^payment$|\bpymt\b|\bpmt\b/i;

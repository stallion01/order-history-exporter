// Shared helpers: dates, money, order merging, CSV, and DOM utilities.
// Loaded both in the exporter page and inside store tabs, so it must stay
// free of chrome.* calls and safe to execute more than once.
(function (root) {
  const OHE = (root.OHE = root.OHE || {});
  OHE.stores = OHE.stores || {};
  OHE.registerStore = (store) => {
    OHE.stores[store.id] = store;
  };

  /* ---------- Dates ---------- */

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_SRC =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

  // Source for a "January 5, 2024" / "Jan 5" style date, for use inside larger regexes.
  OHE.DATE_SRC = `\\b(?:${MONTH_SRC})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`;

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  OHE.localToday = () => isoOf(new Date());

  function build(y, m, d) {
    const date = new Date(y, m - 1, d);
    const valid = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
    return valid ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  const monthNumber = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

  // Finds the first date in free text and returns YYYY-MM-DD, or null.
  // A date with no year takes the current year, or last year if that would be in the future.
  OHE.parseDate = function parseDate(input, today = OHE.localToday()) {
    if (!input) return null;
    const s = String(input);
    let m;
    if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})/))) return build(+m[1], +m[2], +m[3]);
    if ((m = s.match(new RegExp(`\\b(${MONTH_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')))) {
      const month = monthNumber(m[1]);
      if (m[3]) return build(+m[3], month, +m[2]);
      const thisYear = +today.slice(0, 4);
      const guess = build(thisYear, month, +m[2]);
      return guess && guess > today ? build(thisYear - 1, month, +m[2]) : guess;
    }
    if ((m = s.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_SRC})\\.?,?\\s+(\\d{4})\\b`, 'i')))) {
      return build(+m[3], monthNumber(m[2]), +m[1]);
    }
    if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) return build(+m[3], +m[1], +m[2]);
    if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/))) return build(2000 + +m[3], +m[1], +m[2]);
    return null;
  };

  // Turns the UI's date choice into { from, to }; null means unbounded.
  OHE.rangeFor = function rangeFor(choice, today = OHE.localToday()) {
    const thisYear = +today.slice(0, 4);
    const daysAgo = (n) => {
      const [y, m, d] = today.split('-').map(Number);
      return isoOf(new Date(y, m - 1, d - n));
    };
    switch (choice.preset) {
      case 'this-year':
        return { from: `${thisYear}-01-01`, to: today };
      case 'last-year':
        return { from: `${thisYear - 1}-01-01`, to: `${thisYear - 1}-12-31` };
      case 'year':
        return { from: `${choice.year}-01-01`, to: `${choice.year}-12-31` };
      case 'last-30':
        return { from: daysAgo(30), to: today };
      case 'last-90':
        return { from: daysAgo(90), to: today };
      case 'custom':
        return { from: choice.from || null, to: choice.to || null };
      default:
        return { from: null, to: null };
    }
  };

  // Years covered by a range, newest first. Unbounded starts fall back to the end year only.
  OHE.yearsIn = function yearsIn(range, today = OHE.localToday()) {
    const end = +(range.to || today).slice(0, 4);
    const start = range.from ? +range.from.slice(0, 4) : end;
    const years = [];
    for (let y = end; y >= start; y--) years.push(y);
    return years;
  };

  OHE.inRange = function inRange(date, range) {
    if (!range.from && !range.to) return true;
    if (!date) return false;
    if (range.from && date < range.from) return false;
    if (range.to && date > range.to) return false;
    return true;
  };

  // Polls until fn returns something truthy or time runs out, for pages that update in place.
  OHE.waitFor = async function waitFor(fn, ms = 6000) {
    const started = Date.now();
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() - started > ms) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  /* ---------- What a repeat sync still needs to read ---------- */

  // Stands in for "from the beginning" so unbounded ranges can be compared as text.
  const EARLIEST = '0001-01-01';

  function shiftDay(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d + days); // unlike Date.UTC, this keeps years below 100
    return date.toISOString().slice(0, 10);
  }
  OHE.shiftDay = shiftDay;

  // Sorted, with overlapping or touching ranges joined.
  OHE.mergeRanges = function mergeRanges(ranges) {
    const sorted = ranges.map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from.localeCompare(b.from));
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.from <= shiftDay(last.to, 1)) {
        if (range.to > last.to) last.to = range.to;
      } else {
        merged.push(range);
      }
    }
    return merged;
  };

  // The parts of a requested range still worth reading, newest first: anything never
  // fully read, plus a recent window, because recent orders change (delivered, returned).
  // A null `from` in the result means "from the beginning".
  OHE.planGaps = function planGaps(range, covered, today, recheckDays = 60) {
    const from = range.from || EARLIEST;
    const to = range.to && range.to < today ? range.to : today;
    if (from > to) return [];
    const gaps = [];
    let cursor = from;
    for (const part of OHE.mergeRanges(covered)) {
      if (part.to < cursor) continue;
      if (part.from > to) break;
      if (part.from > cursor) gaps.push({ from: cursor, to: shiftDay(part.from, -1) });
      cursor = shiftDay(part.to, 1);
    }
    if (cursor <= to) gaps.push({ from: cursor, to });
    const recent = shiftDay(today, -recheckDays);
    if (to >= recent) gaps.push({ from: recent > from ? recent : from, to });
    return OHE.mergeRanges(gaps)
      .reverse()
      .map((g) => ({ from: g.from === EARLIEST ? null : g.from, to: g.to }));
  };

  // What the order list says about an order. If this changes, its details need re-reading.
  OHE.listFingerprint = (order) => `${order.status || ''}|${order.total === undefined || order.total === null ? '' : order.total}`;

  /* ---------- Money ---------- */

  const CURRENCIES = { $: 'USD', '£': 'GBP', '€': 'EUR' };

  // Returns { amount, currency } for the first price in the text, or null.
  OHE.parseMoney = function parseMoney(input) {
    if (input == null) return null;
    const s = String(input).replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
    const m = s.match(/(-?)\s*(?:US\s*|USD\s*)?([$£€])\s*(-?)\s*(\d[\d,]*(?:\.\d{1,2})?)/);
    if (!m) return null;
    const amount = Number(m[4].replace(/,/g, ''));
    if (!Number.isFinite(amount)) return null;
    return { amount: m[1] || m[3] ? -amount : amount, currency: CURRENCIES[m[2]] };
  };

  /* ---------- Orders ---------- */

  const ORDER_FIELDS = ['date', 'total', 'subtotal', 'tax', 'shipping', 'currency', 'payment', 'deliveryAddress', 'deliveryZip', 'status', 'url', 'detailUrl'];

  OHE.normalizeOrder = function normalizeOrder(order, storeId) {
    return { store: storeId, items: [], ...order };
  };

  // Combines two records of the same order. Later non-empty values win, and an
  // item list replaces the previous one only if it holds at least as many items.
  OHE.mergeOrder = function mergeOrder(base, patch) {
    if (!patch) return base;
    const out = { ...base };
    for (const key of ORDER_FIELDS) {
      if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') out[key] = patch[key];
    }
    const next = patch.items || [];
    if (next.length && next.length >= (out.items || []).length) out.items = next;
    return out;
  };

  OHE.sortOrders = (orders) =>
    [...orders].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.store.localeCompare(b.store));

  /* ---------- CSV ---------- */

  const ITEM_COLUMNS = [
    ['Store', (o) => o.storeName || o.store],
    ['Order Date', (o) => o.date],
    ['Order ID', (o) => o.orderId],
    ['Status', (o) => o.status],
    ['Item', (_o, i) => i && i.name],
    ['Category', (_o, i) => i && i.category],
    ['Quantity', (_o, i) => i && i.quantity],
    ['Item Price', (_o, i) => i && i.price],
    ['Seller', (_o, i) => i && i.seller],
    ['Order Subtotal', (o, _i, first) => (first ? o.subtotal : null)],
    ['Tax', (o, _i, first) => (first ? o.tax : null)],
    ['Shipping', (o, _i, first) => (first ? o.shipping : null)],
    ['Order Total', (o, _i, first) => (first ? o.total : null)],
    ['Payment Method', (o) => o.payment],
    ['Delivery Address', (o) => o.deliveryAddress],
    ['Delivery ZIP', (o) => o.deliveryZip],
    ['Currency', (o) => o.currency],
    ['Item URL', (_o, i) => i && i.url],
    ['Order URL', (o) => o.url],
  ];

  const ORDER_COLUMNS = [
    ['Store', (o) => o.storeName || o.store],
    ['Order Date', (o) => o.date],
    ['Order ID', (o) => o.orderId],
    ['Status', (o) => o.status],
    ['Item Count', (o) => (o.items || []).length],
    ['Items', (o) => (o.items || []).map((i) => i.name).join('; ')],
    ['Order Subtotal', (o) => o.subtotal],
    ['Tax', (o) => o.tax],
    ['Shipping', (o) => o.shipping],
    ['Order Total', (o) => o.total],
    ['Payment Method', (o) => o.payment],
    ['Delivery Address', (o) => o.deliveryAddress],
    ['Delivery ZIP', (o) => o.deliveryZip],
    ['Currency', (o) => o.currency],
    ['Order URL', (o) => o.url],
  ];

  // Numbers stay bare so spreadsheets can sum them. Text starting with a formula
  // character is prefixed with ' because product names come from web pages and
  // must never run as a formula when the file is opened.
  OHE.csvCell = function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // layout 'items': one row per item, with order-level money on the first row only,
  // so summing a column never double counts. layout 'orders': one row per order.
  OHE.toCsv = function toCsv(orders, layout = 'items') {
    const columns = layout === 'orders' ? ORDER_COLUMNS : ITEM_COLUMNS;
    const lines = [columns.map(([title]) => OHE.csvCell(title)).join(',')];
    for (const order of OHE.sortOrders(orders)) {
      if (layout === 'orders') {
        lines.push(columns.map(([, get]) => OHE.csvCell(get(order))).join(','));
        continue;
      }
      const items = order.items && order.items.length ? order.items : [null];
      items.forEach((item, index) => {
        lines.push(columns.map(([, get]) => OHE.csvCell(get(order, item, index === 0))).join(','));
      });
    }
    return `﻿${lines.join('\r\n')}\r\n`; // the BOM makes Excel read UTF-8 correctly
  };

  /* ---------- DOM helpers ---------- */

  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  // Element text with a space between text nodes, so "Total" + "$5" never run together.
  function text(el) {
    if (!el) return '';
    const doc = el.ownerDocument || el;
    const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!SKIP_TEXT.has(node.parentElement && node.parentElement.tagName)) parts.push(node.nodeValue);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // All values next to a label: <div>Total</div><div>$5</div> or <span>Total: $5</span>.
  // Label text changes far less often than class names, so parsers lean on this.
  function labeledAll(root, labelRe) {
    const found = [];
    if (!root) return found;
    for (const el of root.querySelectorAll('*')) {
      if (SKIP_TEXT.has(el.tagName)) continue;
      const t = text(el);
      if (!t || t.length > 80 || !labelRe.test(t)) continue;
      if ([...el.children].some((c) => labelRe.test(text(c)))) continue; // use the innermost match
      const rest = t.replace(labelRe, '').replace(/^[\s:#-]+/, '').trim();
      if (rest) found.push(rest);
      // Also look beside the label: in "Estimated tax to be collected: | $3" the
      // text after the matched words is not the value.
      let node = el;
      for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
        const sibling = node.nextElementSibling;
        const value = sibling && text(sibling);
        if (value) {
          found.push(value);
          break;
        }
      }
    }
    return found;
  }

  const labeled = (root, labelRe) => labeledAll(root, labelRe)[0] || null;

  function labeledMoney(root, labelRe) {
    for (const value of labeledAll(root, labelRe)) {
      const money = OHE.parseMoney(value);
      if (money) return money;
      if (/^free\b/i.test(value)) return { amount: 0, currency: null };
    }
    return null;
  }

  // Reads the money rows of an order summary. Any of them may be absent.
  function summary(root) {
    const total = labeledMoney(root, /^(grand total|order total|total)\b(?!\s+(before|savings|spend|items|tax|shipping|delivery))/i);
    const subtotal = labeledMoney(root, /^((grand|items?|item\(s\))\s*)?subtotal\b/i);
    const tax = labeledMoney(root, /^(total\s+)?(estimated\s+)?(sales\s+)?tax\b/i);
    const shipping = labeledMoney(root, /^(total\s+)?(shipping|delivery)\b/i);
    const out = {};
    if (total) out.total = total.amount;
    if (subtotal) out.subtotal = subtotal.amount;
    if (tax) out.tax = tax.amount;
    if (shipping) out.shipping = shipping.amount;
    const currency = (total && total.currency) || (subtotal && subtotal.currency);
    if (currency) out.currency = currency;
    return out;
  }

  const CARD_BRANDS =
    "Visa|Master\\s?card|American Express|Amex|Discover|Debit(?: card)?|Credit(?: card)?|Capital One|Sam's Club(?: Mastercard)?|Walmart(?: Rewards)?(?: Card| Mastercard)?";
  const CARD_MASK = '(?:ending(?:\\s+(?:in|with))?:?|last digits:?|x+-|x{2,}|[*•]+)';
  const BRANDED_CARD = new RegExp(`\\b(${CARD_BRANDS})\\b[^$\\d]{0,20}?${CARD_MASK}\\s*(\\d{4})\\b(?![\\s-]*\\d)`, 'gi');
  const BARE_CARD = /(?:\bending(?:\s+(?:in|with))?:?|\blast digits:?|\bx+-|\bx{2,}|[*•]+)\s*(\d{4})\b(?![\s-]*\d)/gi;
  const OTHER_PAYMENT = /\b(PayPal|BitPay|Cash(?!\s*(?:back|app))|Gift card|Apple Pay|Google Pay|Venmo|Klarna|Affirm|Afterpay|EBT)\b/gi;
  const PAYMENT_LABEL = /^payments?(\s+(methods?|type|info|information|details))?\b/i;

  // How an order was paid, such as "Visa ending 1234; Gift card". Only recognised
  // patterns are output, never raw page text, so this can't copy an address or a
  // full card number into the CSV. A number must be masked to count, and only its
  // last four digits are kept. Returns undefined if nothing is recognised.
  function payment(root) {
    if (!root) return undefined;
    const found = new Map();
    const add = (value) => {
      if (!found.has(value.toLowerCase())) found.set(value.toLowerCase(), value);
    };
    const digitsSeen = new Set();
    const addBranded = (source) => {
      for (const m of source.matchAll(BRANDED_CARD)) {
        digitsSeen.add(m[2]);
        add(`${m[1].replace(/\s+/g, ' ')} ending ${m[2]}`);
      }
    };
    // A brand next to a masked number is specific enough to trust anywhere on the page.
    addBranded(text(root));
    // Weaker patterns only count inside a payment section: "ending in 1234" could be
    // a phone number elsewhere, and "cash" is a common word.
    for (const section of labeledAll(root, PAYMENT_LABEL)) {
      for (const m of section.matchAll(BARE_CARD)) {
        if (!digitsSeen.has(m[1])) {
          digitsSeen.add(m[1]);
          add(`Card ending ${m[1]}`);
        }
      }
      for (const m of section.matchAll(OTHER_PAYMENT)) add(m[1]);
    }
    return found.size ? [...found.values()].join('; ') : undefined;
  }

  const STATE_ZIP = /\b[A-Z]{2}[\s,]+(\d{5}(?:-\d{4})?)\b/;
  const STREET_START = /(?:^|\s)((?:\d+[A-Za-z-]*\s+\S|P\.?\s*O\.?\s*Box\b).*)$/i;
  const DELIVERY_LABEL = /^(shipping address|delivery address|shipped to|ship to|deliver(?:s|ed|ing)? to|delivery to)\b/i;

  // Splits a US address block into street-to-ZIP text and the ZIP. The recipient's
  // name comes before the street number, so starting there leaves it out. A block
  // with no recognisable street still gives its ZIP.
  function parseAddress(block) {
    const match = block && block.match(STATE_ZIP);
    if (!match) return null;
    const upToZip = block.slice(0, match.index + match[0].length);
    const street = upToZip.match(STREET_START);
    return { deliveryAddress: street ? street[1].trim() : undefined, deliveryZip: match[1] };
  }

  // The delivery address, looked for only beside a delivery or shipping label, so a
  // billing address or a pickup store's address isn't picked up instead.
  function deliveryAddress(root) {
    for (const section of labeledAll(root, DELIVERY_LABEL)) {
      const address = parseAddress(section);
      if (address) return address;
    }
    return {};
  }

  // Walks up from `el` while the ancestor stays free of elements for other orders,
  // giving the whole card for an order without knowing its class name.
  function cardFor(el, isOther) {
    let card = el;
    while (card.parentElement && !/^(BODY|HTML|MAIN)$/.test(card.parentElement.tagName)) {
      if (isOther(card.parentElement)) break;
      card = card.parentElement;
    }
    return card;
  }

  // Smallest ancestor of `el` containing a price, without reaching into another item.
  function rowFor(el, isOther, maxLevels = 6) {
    let node = el;
    for (let i = 0; i < maxLevels && node.parentElement; i++) {
      const parent = node.parentElement;
      if (isOther(parent)) break;
      node = parent;
      if (OHE.parseMoney(text(node))) break;
    }
    return node;
  }

  function absolute(href, base) {
    try {
      return new URL(href, base).href;
    } catch (_e) {
      return null;
    }
  }

  OHE.dom = { text, labeled, labeledAll, labeledMoney, summary, payment, parseAddress, deliveryAddress, cardFor, rowFor, absolute };
})(globalThis);

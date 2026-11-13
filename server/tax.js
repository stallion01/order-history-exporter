// Turns purchases into groups an accountant or tax software can work from.
// Line names follow the 2025 Schedule C and Schedule E (Form 1040). This sorts
// purchases; deciding what is deductible stays with the taxpayer.

const FORMS = {
  'schedule-c': {
    name: 'Schedule C',
    lines: [
      ['8', 'Advertising'],
      ['9', 'Car and truck expenses'],
      ['10', 'Commissions and fees'],
      ['11', 'Contract labor'],
      ['13', 'Depreciation and section 179 expense'],
      ['15', 'Insurance (other than health)'],
      ['17', 'Legal and professional services'],
      ['18', 'Office expense'],
      ['20b', 'Rent or lease: other business property'],
      ['21', 'Repairs and maintenance'],
      ['22', 'Supplies'],
      ['23', 'Taxes and licenses'],
      ['24a', 'Travel'],
      ['24b', 'Deductible meals'],
      ['25', 'Utilities'],
      ['27b', 'Other expenses'],
    ],
  },
  'schedule-e': {
    name: 'Schedule E',
    lines: [
      ['5', 'Advertising'],
      ['6', 'Auto and travel'],
      ['7', 'Cleaning and maintenance'],
      ['8', 'Commissions'],
      ['9', 'Insurance'],
      ['10', 'Legal and other professional fees'],
      ['11', 'Management fees'],
      ['14', 'Repairs'],
      ['15', 'Supplies'],
      ['16', 'Taxes'],
      ['17', 'Utilities'],
      ['18', 'Depreciation expense or depletion'],
      ['19', 'Other'],
    ],
  },
};

// Points a preparer would want raised, shown beside the line they apply to.
const LINE_NOTES = {
  'schedule-c': {
    9: "If you use the standard mileage rate, you can't also deduct fuel and most car costs.",
    '24b': 'Business meals are usually only 50% deductible. The amount shown is the full cost.',
  },
  'schedule-e': {
    6: "If you use the standard mileage rate, you can't also deduct fuel and most car costs.",
  },
};

// At or above the de minimis safe harbor limit for most taxpayers, an item
// may need depreciating rather than deducting in full.
const REVIEW_AMOUNT = 2500;

const cents = (n) => Math.round(n * 100) / 100;

// Shares an order's total across its items, so tax, shipping and discounts are included
// and the items add up to what was actually paid. Where prices are missing, the order is
// split evenly and marked as an estimate.
function allocate(order, items) {
  if (!items.length) return [];
  const lines = items.map((item) => {
    if (typeof item.line_total === 'number') return item.line_total;
    if (typeof item.price === 'number') return item.price * (typeof item.quantity === 'number' ? item.quantity : 1);
    return null;
  });
  const priced = lines.every((line) => line !== null);
  const sum = priced ? lines.reduce((total, line) => total + line, 0) : 0;
  const total = typeof order.total === 'number' ? order.total : null;

  if (total === null) {
    return lines.map((line) => ({ amount: line === null ? null : cents(line), estimated: line !== null ? false : true }));
  }
  if (items.length === 1) return [{ amount: total, estimated: false }];

  const raw = priced && sum !== 0 ? lines.map((line) => (line / sum) * total) : lines.map(() => total / items.length);
  const estimated = !(priced && sum !== 0);
  const amounts = raw.map(cents);
  // Rounding can leave a cent or two over, which goes to the largest item.
  const left = cents(total - amounts.reduce((acc, n) => acc + n, 0));
  if (left) {
    const largest = amounts.reduce((best, n, i) => (Math.abs(n) > Math.abs(amounts[best]) ? i : best), 0);
    amounts[largest] = cents(amounts[largest] + left);
  }
  return amounts.map((amount) => ({ amount, estimated }));
}

// An item's own mark wins. Otherwise a personal rule beats a business one, so that
// "this ZIP is business" with "groceries are personal" errs on the cautious side.
// A "store unless on a business card" rule comes next: at that store, a purchase on a
// card of an account marked Business is business and anything else is personal. When
// the card used isn't known (item.card is null), the other rules decide.
function resolveStatus(item, mark, rules) {
  if (mark) return { status: mark, source: 'you' };
  if (item.card && rules.some((rule) => rule.field === 'store_card' && rule.value === item.store)) {
    return { status: item.card === 'business' ? 'business' : 'personal', source: 'rule' };
  }
  const matching = rules.filter((rule) => {
    switch (rule.field) {
      case 'zip':
        return item.deliveryZip === rule.value;
      case 'payment':
        return item.payment === rule.value;
      case 'store':
        return item.store === rule.value;
      case 'category':
        return item.category === rule.value;
      default:
        return false;
    }
  });
  if (matching.some((rule) => rule.status === 'personal')) return { status: 'personal', source: 'rule' };
  if (matching.some((rule) => rule.status === 'business')) return { status: 'business', source: 'rule' };
  return { status: 'unreviewed', source: 'none' };
}

// items: enriched items for the tax year. lineFor(category) gives this form's line.
function buildReport(formId, items, lineFor) {
  const form = FORMS[formId];
  const notes = LINE_NOTES[formId] || {};
  const lines = new Map(form.lines.map(([line, label]) => [line, { line, label, amount: 0, items: 0, estimated: 0, note: notes[line] || null }]));
  const unassigned = new Map();
  const totals = { business: 0, businessItems: 0, unreviewed: 0, unreviewedItems: 0, personal: 0, personalItems: 0, noAmount: 0 };
  const review = [];

  for (const item of items) {
    const amount = typeof item.amount === 'number' ? item.amount : 0;
    if (typeof item.amount !== 'number') totals.noAmount++;
    if (item.status !== 'business') {
      totals[item.status] += amount;
      totals[`${item.status}Items`]++;
      continue;
    }
    totals.business += amount;
    totals.businessItems++;
    const line = lines.get(lineFor(item.category));
    if (line) {
      line.amount += amount;
      line.items++;
      if (item.estimated) line.estimated++;
    } else {
      const entry = unassigned.get(item.category) || { category: item.category, amount: 0, items: 0 };
      entry.amount += amount;
      entry.items++;
      unassigned.set(item.category, entry);
    }
    if (amount >= REVIEW_AMOUNT) review.push(item);
  }

  const money = (entry) => ({ ...entry, amount: cents(entry.amount) });
  for (const key of ['business', 'unreviewed', 'personal']) totals[key] = cents(totals[key]);
  return {
    form: formId,
    formName: form.name,
    lines: [...lines.values()].filter((line) => line.items).map(money),
    unassigned: [...unassigned.values()].map(money),
    totals,
    review,
    reviewAmount: REVIEW_AMOUNT,
  };
}

module.exports = { FORMS, allocate, resolveStatus, buildReport, cents };

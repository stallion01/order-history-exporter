// Costco keeps warehouse receipts and costco.com orders on one page, under two tabs,
// each filtered by a three-month "Showing" list. A warehouse receipt has no page of its
// own: View Receipt opens it in a popup. So the list is read through `views` (one per
// tab and period), and details through `openDetail`, which finds the order on the list
// page again and opens it there.
//
// Read from the page's own ids and automation-id attributes, which Costco's tests rely
// on, rather than from its generated class names.
//
// Not seen on the one account this was written against, so unverified: a warehouse
// period with no receipts, and costco.com orders with several shipments.
(function (root) {
  const OHE = root.OHE;
  const { text, summary, rowFor, absolute } = OHE.dom;
  const ORIGIN = 'https://www.costco.com';
  // Redirects to the orders page, whose own address holds an id this file needn't know.
  const LIST_URL = `${ORIGIN}/OrderStatusCmd`;
  const RECEIPT_CARD = '[id^="viewRecieptBtn_"]'; // Costco's spelling
  const ONLINE_LINK = 'a[id^="orderNumber_"]';
  const TABS = { warehouse: 'myWarehouseOrdersTab', online: 'myOnlineOrdersTab' };
  const NEXT_PAGE = 'nav[aria-label="pagination navigation"] button[aria-label="Go to next page"]';
  const ONLINE_STATUS = /\b(Delivered|Shipped|Cancell?ed|Returned|Refunded|Picked up|Arriving|Preparing|Processing)\b(\s+on\s+\d{1,2}\/\d{1,2}\/\d{4})?/i;
  // openDetail acts at most this often, so the page can answer one step before the next.
  const STEP_MS = 1200;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  const auto = (node, id) => node.querySelector(`[automation-id="${id}"]`);
  const pad = (n) => String(n).padStart(2, '0');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A warehouse receipt is known by its long barcode number; an online order's is short.
  const isReceipt = (orderId) => /^\d{20,}$/.test(orderId);

  /* ---------- The "Showing" periods ---------- */

  // "2026 June - August" is June to August 2026. A period that crosses the new year is
  // named for the year it ends in: "2026 December - February" starts in December 2025.
  function periodOf(label) {
    const m = String(label).match(/^(\d{4})\s+([A-Za-z]+)\s*-\s*([A-Za-z]+)$/);
    if (!m) return null;
    const start = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const end = MONTHS.indexOf(m[3].slice(0, 3).toLowerCase()) + 1;
    if (!start || !end) return null;
    const year = Number(m[1]);
    return {
      from: `${start > end ? year - 1 : year}-${pad(start)}-01`,
      to: `${year}-${pad(end)}-${pad(new Date(year, end, 0).getDate())}`,
    };
  }

  // Each choice in the list, known by the month it starts in ("2026-06") rather than by
  // its wording, which is a placeholder for a moment while the page loads. A choice with
  // no dates in its name, "Last 3 Months", is 'recent'.
  const RECENT = 'recent';
  function periods(select) {
    const all = [...select.options].map((option, index) => {
      const dates = periodOf(option.text.trim());
      return { index, dates, key: dates ? dates.from.slice(0, 7) : RECENT };
    });
    const newest = all.reduce((latest, p) => (p.dates && p.dates.to > latest ? p.dates.to : latest), '');
    return { all, newest };
  }

  // The periods a date range needs, newest first. The recent one is read whenever the
  // range reaches past the newest period that has dates.
  function periodsFor(select, range) {
    const { all, newest } = periods(select);
    const keys = all
      .filter((p) =>
        p.dates
          ? (!range.to || p.dates.from <= range.to) && (!range.from || p.dates.to >= range.from)
          : !range.to || !newest || range.to > newest
      )
      .map((p) => p.key);
    return [...new Set(keys)];
  }

  // The period an order of this date is listed under, or null if the list doesn't reach it.
  function periodForDate(select, date) {
    const { all, newest } = periods(select);
    const named = date && all.find((p) => p.dates && date >= p.dates.from && date <= p.dates.to);
    if (named) return named.key;
    return all.some((p) => !p.dates) && (!date || !newest || date > newest) ? RECENT : null;
  }

  const chosenPeriod = (select) => (periods(select).all[select.selectedIndex] || {}).key;

  function setPeriod(select, key) {
    const period = periods(select).all.find((p) => p.key === key);
    if (!period) return false;
    select.selectedIndex = period.index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const listSignature = (doc) =>
    [...doc.querySelectorAll(`${RECEIPT_CARD}, ${ONLINE_LINK}`)].map((el) => el.id).join('|');

  // True once the open tab shows its orders, or says it has none.
  function listArrived(doc) {
    if (listSignature(doc)) return true;
    const panel = doc.querySelector('[role="tabpanel"]:not([hidden])');
    return /\bno \w+ are available\b/i.test(text(panel));
  }

  /* ---------- The list ---------- */

  function readReceiptCard(card, ctx) {
    const orderId = card.id.split('_')[1] || '';
    if (!isReceipt(orderId)) return null;
    const totalBox = auto(card, 'totalPrice');
    const total = OHE.parseMoney(text(totalBox));
    const fields = totalBox && totalBox.parentElement ? [...totalBox.parentElement.children] : [];
    const dated = fields.find((el) => /^\d{1,2}\/\d{1,2}\/\d{4}/.test(text(el)));
    const kind = fields.find((el) => el !== totalBox && el.hasAttribute('automation-id'));
    const warehouse = fields.find((el) => el !== dated && el !== totalBox && !el.hasAttribute('automation-id') && text(el));
    const refund = /refund/i.test(text(totalBox)) || (total && total.amount < 0);
    return {
      orderId,
      date: dated ? OHE.parseDate(text(dated), ctx.today) : null,
      total: total ? total.amount : undefined,
      currency: total ? total.currency : undefined,
      // Which warehouse, since a household may shop at more than one.
      status: `${text(kind) || 'In-Warehouse'}${refund ? ' refund' : ''}${warehouse ? `, ${text(warehouse)}` : ''}`,
      url: LIST_URL,
      detailUrl: LIST_URL,
      items: [],
    };
  }

  function readOnlineCard(link, links, doc, ctx) {
    const orderId = link.id.split('_')[1] || '';
    if (!orderId) return null;
    const card = OHE.dom.cardFor(link, (el) => links.some((other) => other !== link && el.contains(other)));
    const total = OHE.parseMoney(text(doc.getElementById(`totalPrice_${orderId}`)));
    const status = text(card).match(ONLINE_STATUS);
    return {
      orderId,
      date: OHE.parseDate(text(doc.getElementById(`orderDate_${orderId}`)), ctx.today),
      total: total ? total.amount : undefined,
      currency: total ? total.currency : undefined,
      status: status ? status[0].trim() : undefined,
      url: LIST_URL,
      detailUrl: LIST_URL,
      items: [],
    };
  }

  function extractList(doc, ctx) {
    const receipts = [...doc.querySelectorAll(RECEIPT_CARD)].map((card) => readReceiptCard(card, ctx));
    const links = [...doc.querySelectorAll(ONLINE_LINK)];
    const online = links.map((link) => readOnlineCard(link, links, doc, ctx));
    return { orders: [...receipts, ...online].filter(Boolean) };
  }

  /* ---------- A warehouse receipt ---------- */

  // "12.99 N", "3.70-", "379.99- Y": an amount, a trailing minus for money back, and
  // sometimes a tax code.
  function receiptAmount(cell) {
    const m = String(cell || '').match(/^(-?)\s*([\d,]+\.\d{2})\s*(-?)(?:\s+[A-Z])?$/);
    if (!m) return null;
    const amount = Number(m[2].replace(/,/g, ''));
    return m[1] || m[3] ? -amount : amount;
  }

  const cents = (n) => Math.round(n * 100) / 100;

  // How a receipt names what paid, and how it's reported. Only these words are ever
  // output, never the receipt's own text.
  const TENDERS = [
    [/visa/i, 'Visa', true],
    [/master/i, 'Mastercard', true],
    [/amex|american express/i, 'American Express', true],
    [/discover/i, 'Discover', true],
    [/debit/i, 'Debit card', true],
    [/shop card|cash card/i, 'Costco Shop Card', false],
    [/^cash$/i, 'Cash', false],
    [/\bebt\b/i, 'EBT', false],
    [/^check$/i, 'Check', false],
  ];

  function readPayment(rows) {
    const digits = rows.map((cells) => (cells.find(Boolean) || '').match(/^X{4,}\s*(\d{4})$/)).filter(Boolean).map((m) => m[1]);
    const found = [];
    for (const cells of rows) {
      const filled = cells.filter(Boolean);
      if (filled.length !== 2 || receiptAmount(filled[1]) === null) continue;
      const tender = TENDERS.find(([pattern]) => pattern.test(filled[0]));
      if (!tender) continue;
      const last4 = tender[2] ? digits.shift() : null;
      found.push(last4 ? `${tender[1]} ending ${last4}` : tender[1]);
    }
    // A refund to a card names the card only by its masked number.
    for (const last4 of digits) found.push(`Card ending ${last4}`);
    return found.length ? [...new Set(found)].join('; ') : undefined;
  }

  // The receipt is one table. Each purchase is a row of code, item number, name and
  // amount. Two other rows change the purchase they belong to:
  //   "2 @ 12.99"                 above a purchase: its quantity, the amount being for all of them
  //   "/1978580" or "/ TRUFFLES"  below a purchase, with an amount ending "-": money off it
  // Money off is taken out of the item's price, so the items add up to the subtotal.
  function readReceipt(receipt) {
    const rows = [...receipt.querySelectorAll('table tr')].map((tr) => [...tr.children].map(text));
    const totalAt = rows.findIndex((cells) => cells.length >= 2 && /^total$/i.test(cells[cells.length - 2]));
    const itemRows = totalAt >= 0 ? rows.slice(0, totalAt + 1) : rows;
    const out = {};
    const items = [];
    let quantity = null;
    for (const cells of itemRows) {
      const filled = cells.filter(Boolean);
      const multiple = filled.length === 1 && filled[0].match(/^(\d+(?:\.\d+)?)\s*@\s*[\d,]+\.\d{2}$/);
      if (multiple) {
        quantity = Number(multiple[1]);
        continue;
      }
      if (cells.length < 2) continue;
      const amount = receiptAmount(cells[cells.length - 1]);
      const label = cells[cells.length - 2];
      if (amount === null || !label) continue;
      if (/^subtotal$/i.test(label)) out.subtotal = amount;
      else if (/^tax$/i.test(label)) out.tax = amount;
      else if (/^total$/i.test(label)) out.total = amount;
      else if (cells.length >= 4 && /^\d+$/.test(cells[cells.length - 3])) {
        if (label.startsWith('/')) {
          const about = label.slice(1).trim();
          const item = [...items].reverse().find((i) => i.number === about) || items[items.length - 1];
          if (item) item.lineTotal += amount;
        } else {
          items.push({ name: label, number: cells[cells.length - 3], quantity: quantity || 1, lineTotal: amount });
        }
        quantity = null;
      }
    }
    if (out.total !== undefined) out.currency = 'USD';
    out.payment = readPayment(totalAt >= 0 ? rows.slice(totalAt + 1) : []);
    out.items = items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: cents(item.lineTotal / item.quantity),
      lineTotal: cents(item.lineTotal),
    }));
    return out;
  }

  // A fuel receipt has no table. It reads as labels and values in order: "Pump",
  // "Gallons", "Price", then their values; "Product", "Amount", then the fuel and what it
  // cost; "Total Sale"; and the card as a two-letter code before "Acct #".
  const CARD_CODES = { VI: 'Visa', MC: 'Mastercard', AX: 'American Express', DS: 'Discover', DB: 'Debit card' };
  function readFuelReceipt(receipt) {
    const leaves = [...receipt.querySelectorAll('*')].filter((el) => !el.children.length).map(text).filter(Boolean);
    const after = (label) => {
      const at = leaves.findIndex((leaf) => label.test(leaf));
      return at >= 0 ? leaves.slice(at + 1) : [];
    };
    const number = (value) => Number(String(value).replace(/[$,]/g, ''));
    const gallons = after(/^gallons$/i).find((leaf) => /^[\d,]+\.\d{3}$/.test(leaf));
    const perGallon = after(/^price$/i).find((leaf) => /^\$\s*\d+\.\d{2,3}$/.test(leaf));
    const [product, amount] = after(/^amount$/i);
    const total = OHE.parseMoney(after(/^total sale$/i)[0]) || OHE.parseMoney(amount);
    const out = { items: [] };
    if (total) {
      out.total = total.amount;
      out.currency = 'USD';
    }
    if (product && !/^\$/.test(product) && total) {
      const item = { name: `${product} fuel`, lineTotal: (OHE.parseMoney(amount) || total).amount };
      if (gallons) item.quantity = number(gallons);
      if (perGallon) item.price = number(perGallon);
      out.items.push(item);
    }
    const account = leaves.findIndex((leaf) => /^[A-Z]{2}\s+Acct\s*#$/i.test(leaf));
    const digits = account >= 0 ? (leaves[account + 1] || '').match(/^[*X\s]+(\d{4})$/i) : null;
    if (digits) out.payment = `${CARD_CODES[leaves[account].slice(0, 2).toUpperCase()] || 'Card'} ending ${digits[1]}`;
    return out;
  }

  // The receipt in the popup, if it is this order's. A warehouse receipt prints its
  // number. A fuel receipt doesn't, so openDetail also notes which one it opened.
  function receiptShowing(doc, orderId) {
    const opened = doc.documentElement.getAttribute('data-ohe-opened') === orderId;
    return [...doc.querySelectorAll('#dataToPrint')].find((el) => text(el) && (opened || text(el).includes(orderId)));
  }

  /* ---------- A costco.com order ---------- */

  const onlineShowing = (doc, orderId) => text(auto(doc, 'orderNumber')).includes(orderId);

  function readOnlineOrder(doc) {
    const totals = auto(doc, 'orderTotalOutput');
    const shipTo = auto(doc, 'ShippingAddres'); // Costco's spelling
    const paidWith = auto(doc, 'paymentMethod');
    const address = shipTo && shipTo.parentElement ? OHE.dom.parseAddress(text(shipTo.parentElement)) : null;
    const numbers = [...doc.querySelectorAll('[automation-id="itemNumber"]')];
    const items = [];
    for (const number of numbers) {
      const row = rowFor(number, (el) => numbers.some((other) => other !== number && el.contains(other)));
      const link = [...row.querySelectorAll('a[href]')].find((a) => text(a));
      if (!link) continue;
      const rowText = text(row);
      const price = OHE.parseMoney(rowText);
      const quantity = rowText.match(/\bQuantity:?\s*(\d+)/i);
      const item = { name: text(link), url: absolute(link.getAttribute('href'), ORIGIN) };
      if (price) item.price = price.amount;
      if (quantity) item.quantity = Number(quantity[1]);
      items.push(item);
    }
    return {
      ...(totals ? summary(totals) : {}),
      ...(address || {}),
      payment: paidWith && paidWith.parentElement ? OHE.dom.payment(paidWith.parentElement) : undefined,
      items,
    };
  }

  /* ---------- Finding an order on the list page again ---------- */

  // One step towards showing an order's details, judged afresh from what the page shows
  // each time: the right tab, the period holding the order's date, the page of that
  // period it's on, then the order itself. Returns true once the details are showing.
  function openDetail(doc, order) {
    const receipt = isReceipt(order.orderId);
    if (receipt ? receiptShowing(doc, order.orderId) : onlineShowing(doc, order.orderId)) return true;

    const html = doc.documentElement;
    if (Date.now() - Number(html.getAttribute('data-ohe-step') || 0) < STEP_MS) return false;
    const step = (el) => {
      html.setAttribute('data-ohe-step', String(Date.now()));
      el.click();
      return false;
    };

    const otherReceipt = auto(doc, 'closePopup');
    if (otherReceipt) {
      html.removeAttribute('data-ohe-opened');
      return step(otherReceipt);
    }
    const card = doc.getElementById(`${receipt ? 'viewRecieptBtn' : 'orderNumber'}_${order.orderId}`);
    const opener = card && receipt ? card.querySelector('button') : card;
    if (opener) {
      if (receipt) html.setAttribute('data-ohe-opened', order.orderId);
      return step(opener);
    }

    const tab = auto(doc, TABS[receipt ? 'warehouse' : 'online']);
    if (!tab) return false; // still loading
    if (tab.getAttribute('aria-selected') !== 'true') return step(tab);
    const select = doc.getElementById('Showing');
    if (!select) return false;
    const period = periodForDate(select, order.date);
    if (!period) return false; // older than the list goes back
    if (chosenPeriod(select) !== period) {
      html.setAttribute('data-ohe-step', String(Date.now()));
      setPeriod(select, period);
      return false;
    }
    const next = doc.querySelector(NEXT_PAGE);
    if (next && !next.disabled) return step(next);
    return false;
  }

  OHE.registerStore({
    id: 'costco',
    name: 'Costco',
    ordersUrl: LIST_URL,
    hosts: ['www.costco.com'],

    startUrls() {
      return [LIST_URL];
    },

    detect(doc, loc) {
      // Sign-in is on another host, which the crawler already reports for the user.
      if (/^signin\./i.test(loc.hostname) || /logon|signin/i.test(loc.pathname)) return 'login';
      if (/access denied/i.test(doc.title)) return 'challenge';
      return null;
    },

    // "warehouse|2026-06": a tab, and the period starting that month.
    views: {
      list(doc, ctx) {
        const select = doc.getElementById('Showing');
        if (!select || !auto(doc, TABS.warehouse) || !auto(doc, TABS.online)) return null;
        const wanted = periodsFor(select, ctx.range);
        return ['warehouse', 'online'].flatMap((kind) => wanted.map((period) => `${kind}|${period}`));
      },

      async apply(doc, view) {
        const [kind, period] = [view.slice(0, view.indexOf('|')), view.slice(view.indexOf('|') + 1)];
        const tab = await OHE.waitFor(() => auto(doc, TABS[kind]), 15000);
        if (!tab) return false;
        if (tab.getAttribute('aria-selected') !== 'true') {
          tab.click();
          if (!(await OHE.waitFor(() => tab.getAttribute('aria-selected') === 'true', 8000))) return false;
        }
        // The tab's first list, for the recent period, arrives before the period is changed.
        const select = await OHE.waitFor(() => doc.getElementById('Showing'), 8000);
        if (!select) return false;
        await OHE.waitFor(() => listArrived(doc), 10000);
        await pause(500);
        if (chosenPeriod(select) === period) return true;
        const before = listSignature(doc);
        if (!setPeriod(select, period)) return false;
        // Two periods running can both list nothing, so there may be no change to see.
        await pause(800);
        await OHE.waitFor(() => listArrived(doc) && (!listSignature(doc) || listSignature(doc) !== before), 6000);
        await pause(500);
        return true;
      },
    },

    extractList,

    nextElement(doc) {
      return doc.querySelector(NEXT_PAGE);
    },

    openDetail,

    extractDetail(doc, order) {
      if (!isReceipt(order.orderId)) return onlineShowing(doc, order.orderId) ? readOnlineOrder(doc) : null;
      const receipt = receiptShowing(doc, order.orderId);
      if (!receipt) return null;
      return receipt.querySelector('table tr') ? readReceipt(receipt) : readFuelReceipt(receipt);
    },
  });
})(globalThis);

// Target's purchase history has two tabs on one page: Online (shipped, pickup and
// Drive Up orders) and In-store (purchases at a register, when the card or Target
// Circle account was recognised). Each is read as a `view`. Both kinds of order have
// their own page, built from the same parts, so one details parser serves both.
//
// Read from links, ids and data-test attributes rather than from generated class names.
//
// Not seen on the one account this was written against, so unverified: a tab with no
// purchases, a sign-in or security check part-way through, and returns.
(function (root) {
  const OHE = root.OHE;
  const { text, summary, rowFor, absolute } = OHE.dom;
  const ORIGIN = 'https://www.target.com';
  const LIST_URL = `${ORIGIN}/orders`;
  const ORDER_LINK = 'a[href*="/orders/"]';
  const TABS = { online: 'tabOnline', instore: 'tabInstore' };
  const DELIVERY_LABEL = /^(delivered|delivers|delivering|shipped|shipping|ships) to$/i;
  const SAFE_PAYMENT = /^[A-Za-z][A-Za-z '&-]{1,40}$/;

  const tested = (node, name) => node.querySelector(`[data-test="${name}"]`);

  // "/orders/912000000000001" online, "/orders/stores/1234-5678-9012-3456" in a store.
  // Other links under /orders/, such as an order's receipts, aren't orders.
  function orderIdOf(href) {
    const path = String(href || '').split(/[?#]/)[0];
    const m = path.match(/\/orders\/(?:stores\/([\d-]{8,})|(\d{6,}))$/);
    return m ? m[1] || m[2] : null;
  }

  // Picture descriptions arrive with their symbols still spelled out, as in "&#8482;".
  const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  function decode(value) {
    return String(value)
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_m, name) => NAMED[name]);
  }

  // The list shows each item only as a picture, described as "Name - quantity: 2".
  // A cancelled package's pictures are left out, as its items are on the order's page.
  // Otherwise the list would name more items than that page, and the fuller list is kept.
  function listItems(card) {
    const pictures = card.querySelectorAll('[id="item-picture-container"] img[alt]');
    return [...(pictures.length ? pictures : card.querySelectorAll('img[alt]'))]
      .filter((img) => {
        const pack = img.closest('[data-test="order-history-v2-package-card"]');
        return !pack || !/^cancell?ed\b/i.test(text(pack.querySelector('h4')));
      })
      .map((img) => {
        const alt = decode(img.getAttribute('alt')).trim();
        const quantity = alt.match(/\s+-\s+quantity:\s*(\d+)$/i);
        const item = { name: quantity ? alt.slice(0, quantity.index).trim() : alt };
        if (quantity) item.quantity = Number(quantity[1]);
        return item;
      })
      .filter((item) => item.name.length > 3);
  }

  // "Picked up, Drive Up at Anytown East", one for each package.
  function statusOf(card) {
    const found = [...card.querySelectorAll('h4')].map((heading) => {
      const what = text(heading.firstElementChild || heading);
      const where = heading.nextElementSibling && heading.nextElementSibling.tagName === 'P' ? text(heading.nextElementSibling) : '';
      return where ? `${what}, ${where}` : what;
    });
    return [...new Set(found.filter(Boolean))].join('; ') || undefined;
  }

  // Set by extractList for nextElement, which is asked straight afterwards. More
  // purchases load onto the same page, so the page never falls wholly before the start
  // date, and the crawler's own check for that can't end the listing.
  let reachedStart = false;

  function extractList(doc, ctx) {
    const links = new Map();
    for (const link of doc.querySelectorAll(ORDER_LINK)) {
      const orderId = orderIdOf(link.getAttribute('href'));
      if (orderId && !links.has(orderId)) links.set(orderId, link);
    }
    const all = [...doc.querySelectorAll(ORDER_LINK)];
    const orders = [];
    for (const [orderId, link] of links) {
      // Each order sits in a block carrying its number. Failing that, widen from its link
      // until another order's would be taken in.
      const card =
        doc.getElementById(orderId) ||
        OHE.dom.cardFor(link, (el) => all.some((other) => el.contains(other) && orderIdOf(other.getAttribute('href')) !== orderId));
      const cardText = text(card);
      const total = OHE.parseMoney(cardText);
      const url = absolute(link.getAttribute('href').split(/[?#]/)[0], ORIGIN);
      orders.push({
        orderId,
        date: OHE.parseDate(cardText, ctx.today),
        total: total ? total.amount : undefined,
        currency: total ? total.currency : undefined,
        status: statusOf(card),
        url,
        detailUrl: url,
        items: listItems(card),
      });
    }
    const from = ctx.range && ctx.range.from;
    reachedStart = Boolean(from) && orders.some((order) => order.date && order.date < from);
    return { orders };
  }

  // An order can be picked up in part and cancelled in part. Each package has a heading
  // above its items, and a cancelled package's items weren't bought: the order's
  // subtotal leaves them out, so they are left out here too.
  function cancelled(heading, packages) {
    const own = packages.filter((p) => p.compareDocumentPosition(heading) & 4 /* heading follows it */).pop();
    return Boolean(own) && /^cancell?ed\b/i.test(text(own));
  }

  function readItems(doc) {
    const packages = [...doc.querySelectorAll('[data-test="package-card-heading"]')];
    const headings = [...doc.querySelectorAll('h3[id^="item-"]')].filter((heading) => !cancelled(heading, packages));
    return headings.map((heading) => {
      const row = rowFor(heading, (el) => headings.some((other) => other !== heading && el.contains(other)));
      // "$10.00 unit price", "$2.99 each" or "$4.00": always the price of one.
      const price = OHE.parseMoney(text(tested(row, 'order-price')) || text(row));
      const quantity = text(row).match(/\bQty:?\s*(\d+)/i);
      const item = { name: text(heading) };
      if (quantity) item.quantity = Number(quantity[1]);
      if (price) item.price = price.amount;
      return item;
    });
  }

  // Money rows carry their own names. "Free" fulfillment counts as no shipping charge.
  function readSummary(doc) {
    // By label only if the page's own names for the rows have gone.
    const out = tested(doc, 'grand-total') ? {} : summary(doc.body);
    const rows = { total: 'grand-total', subtotal: 'sub-total-value', tax: 'tax-total', shipping: 'shipping-fee-value' };
    for (const [field, name] of Object.entries(rows)) {
      const value = text(tested(doc, name));
      const money = OHE.parseMoney(value);
      if (money) out[field] = money.amount;
      else if (/^free\b/i.test(value)) out[field] = 0;
      if (money && money.currency && field === 'total') out.currency = money.currency;
    }
    return out;
  }

  // "Target Circle Debit Card" beside "* 1234". The name is only kept if it reads as a
  // plain card name, and only the last four digits of the number.
  function readPayment(doc) {
    const found = new Set();
    for (const el of doc.querySelectorAll('[data-test="breakdown-payment_sub_type_value"]')) {
      const name = SAFE_PAYMENT.test(text(el)) ? text(el) : 'Card';
      let digits = null;
      for (let node = el.parentElement, up = 0; node && up < 3 && !digits; node = node.parentElement, up++) {
        digits = text(node).match(/[*•x]\s*(\d{4})\b(?![\s-]*\d)/i);
      }
      found.add(digits ? `${name} ending ${digits[1]}` : name);
    }
    return found.size ? [...found].join('; ') : OHE.dom.payment(doc.body);
  }

  // Under "Delivered to": the name, then the street, then the city, state and ZIP.
  function readAddress(doc) {
    for (const label of doc.querySelectorAll('p, h2, h3, h4, span, div')) {
      if (label.children.length || !DELIVERY_LABEL.test(text(label)) || !label.parentElement) continue;
      const address = OHE.dom.parseAddress(text(label.parentElement));
      if (address) return address;
    }
    return {};
  }

  OHE.registerStore({
    id: 'target',
    name: 'Target',
    ordersUrl: LIST_URL,
    hosts: ['www.target.com'],

    startUrls() {
      return [LIST_URL];
    },

    detect(doc, loc) {
      if (/\/(login|signin|sign-in)\b/i.test(loc.pathname)) return 'login';
      if (/access denied|are you a (robot|human)/i.test(doc.title)) return 'challenge';
      return null;
    },

    views: {
      list(doc) {
        return tested(doc, TABS.online) && tested(doc, TABS.instore) ? ['online', 'instore'] : null;
      },

      async apply(doc, view) {
        const tab = await OHE.waitFor(() => tested(doc, TABS[view]), 15000);
        if (!tab) return false;
        if (tab.getAttribute('aria-selected') === 'true') return true;
        tab.click();
        if (!(await OHE.waitFor(() => tab.getAttribute('aria-selected') === 'true', 8000))) return false;
        // The other tab's purchases stay on the page until this one's arrive.
        const instore = (link) => /\/orders\/stores\//.test(link.getAttribute('href'));
        await OHE.waitFor(() => {
          const links = [...doc.querySelectorAll(ORDER_LINK)].filter((link) => orderIdOf(link.getAttribute('href')));
          return links.length && links.every((link) => instore(link) === (view === 'instore'));
        }, 8000);
        return true;
      },
    },

    extractList,

    // A button, so it's clicked, and the list grows on the same page.
    nextElement(doc) {
      if (reachedStart) return null;
      return [...doc.querySelectorAll('button')].find((button) => /^load more\b/i.test(text(button))) || null;
    },

    extractDetail(doc) {
      return { ...readSummary(doc), ...readAddress(doc), payment: readPayment(doc), items: readItems(doc) };
    },
  });
})(globalThis);

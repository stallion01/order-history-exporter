// Walmart and Sam's Club share a platform, so one parser serves both.
// Their class names are generated and change often, so this works from links,
// test ids and visible labels rather than from CSS classes.
(function (root) {
  const OHE = root.OHE;
  const { text, labeledMoney, summary, payment, cardFor, rowFor, absolute } = OHE.dom;
  const DATED_ORDER = new RegExp(`(${OHE.DATE_SRC})\\s+(?:order|purchase)`, 'i');
  const ORDER_ON = new RegExp(`(?:order(?:ed)?|purchased?)\\s+(?:date|on|placed)?:?\\s*(${OHE.DATE_SRC})`, 'i');
  const ANY_DATE = new RegExp(OHE.DATE_SRC, 'i');
  const STATUS = /\b(Delivered|Picked up|Canceled|Cancelled|Returned|Refunded|Shipped|Arrives|Preparing|Purchased)\b[^$]{0,40}/i;
  const ID_DIGITS = /(\d{10,})/;
  // Pictures on order pages that aren't purchases: receipt barcodes and payment logos.
  const NOT_A_PRODUCT = /logo|icon|walmart|sam's club|barcode|^(visa|master\s?card|discover|amex|american express|cash|paypal|gift card|debit|credit)( card)?$/i;
  const VERIFY_PATH = /\/(verify|verification|otp|mfa|2fa|step-?up)\b|\/account\/[^?]*(verif|challenge)/i;
  const VERIFY_TEXT =
    /verify (it's|its|that it's) you|confirm (it's|its) you|verification code|(enter|send|resend)( me)?( the| a| your)? code|code (to|by|via) (your )?(phone|email|text)/i;

  // Finds the order id an element refers to, from its link, test id, or text.
  function orderIdOf(el) {
    const href = el.getAttribute('href') || '';
    const fromHref = href.match(/\/orders?\/(?:details\/)?(\d{10,})/);
    if (fromHref) return fromHref[1];
    for (const attr of ['data-automation-id', 'data-testid', 'aria-label']) {
      const m = (el.getAttribute(attr) || '').match(ID_DIGITS);
      if (m) return m[1];
    }
    return null;
  }

  OHE.walmartFamilyStore = function walmartFamilyStore({ id, name, origin, hosts, itemLink, loginPath }) {
    const detailUrlFor = (orderId) =>
      // In-store purchases have much longer ids and use a separate view.
      `${origin}/orders/${orderId}${orderId.length >= 20 ? '?storePurchase=true' : ''}`;

    // Order pages mark each item with test ids. In-store items have no product link,
    // so this is the only place their prices appear.
    function readItemStacks(root) {
      return [...root.querySelectorAll('[data-testid="itemtile-stack"]')]
        .map((stack) => {
          const image = stack.querySelector('img[alt]');
          const name = text(stack.querySelector('[data-testid="productName"]')) || (image && image.getAttribute('alt')) || '';
          if (!name) return null;
          const link = stack.querySelector('a[href]');
          const href = link ? link.getAttribute('href') : '';
          const quantity = text(stack).match(/\bQty:?\s*([\d.]+)/i);
          const unit = OHE.parseMoney(text(stack.querySelector('[data-testid="productDescription"]')));
          // The line price is split into separate pieces: "$", "12", "34".
          const lineEl = stack.querySelector('[data-testid="line-price"]');
          const parts = lineEl ? [...lineEl.querySelectorAll('span')].filter((s) => !s.children.length && /\d/.test(text(s))).map(text) : [];
          const lineTotal = parts.length === 2 ? Number(`${parts[0].replace(/,/g, '')}.${parts[1]}`) : (OHE.parseMoney(text(lineEl)) || {}).amount;
          const item = { name };
          if (href) item.url = absolute(href, origin);
          if (quantity) item.quantity = Number(quantity[1]);
          if (unit) item.price = unit.amount;
          if (Number.isFinite(lineTotal)) item.lineTotal = lineTotal;
          return item;
        })
        .filter(Boolean);
    }

    // "*1234" beside a card logo whose alt text is the brand. It can appear twice,
    // because the section is repeated for different screen sizes.
    function readCardPayments(root) {
      const found = new Set();
      for (const el of root.querySelectorAll('span, div')) {
        if (el.children.length) continue;
        const digits = text(el).match(/^\*(\d{4})$/);
        if (!digits) continue;
        let node = el;
        let logo = null;
        for (let up = 0; up < 4 && node && !logo; up++, node = node.parentElement) logo = node.querySelector('img[alt]');
        const alt = logo ? logo.getAttribute('alt').trim() : '';
        const brand = /^[A-Za-z][A-Za-z '-]{1,30}$/.test(alt) ? alt : 'Card';
        found.add(`${brand} ending ${digits[1]}`);
      }
      return found.size ? [...found].join('; ') : undefined;
    }

    function readItems(root, withPrices) {
      const stacks = readItemStacks(root);
      if (stacks.length) return stacks;
      const links = [...root.querySelectorAll(itemLink)];
      const items = new Map();
      for (const link of links) {
        const img = link.querySelector('img[alt]');
        const itemName = text(link) || (img && img.getAttribute('alt')) || '';
        const url = absolute(link.getAttribute('href'), origin);
        if (!itemName || !url) continue;
        const key = url.split('?')[0];
        if (items.has(key)) continue;
        const item = { name: itemName, url };
        if (withPrices) {
          const row = rowFor(link, (el) => links.some((l) => l !== link && el.contains(l) && l.href.split('?')[0] !== key));
          const rowText = text(row);
          const price = OHE.parseMoney(rowText);
          if (price) item.price = price.amount;
          const qty = rowText.match(/\bQty:?\s*(\d+)/i);
          if (qty) item.quantity = Number(qty[1]);
        }
        items.set(key, item);
      }
      if (items.size) return [...items.values()];
      // Order cards often show only thumbnails, whose alt text is the product name.
      return [...root.querySelectorAll('img[alt]')]
        .map((img) => img.getAttribute('alt').trim())
        .filter((alt) => alt.length > 3 && !NOT_A_PRODUCT.test(alt))
        .map((alt) => ({ name: alt }));
    }

    function orderMarkers(doc) {
      const markers = new Map();
      const candidates = doc.querySelectorAll(
        'a[href*="/orders/"], a[href*="/order/"], [data-automation-id*="order" i], [data-testid*="order" i], button[aria-label*="order" i]'
      );
      for (const el of candidates) {
        const orderId = orderIdOf(el);
        if (orderId && !markers.has(orderId)) markers.set(orderId, el);
      }
      return markers;
    }

    return {
      id,
      name,
      hosts,
      ordersUrl: `${origin}/orders`,

      // No URL date filter is assumed: listings are walked newest first and the
      // crawler stops once a whole page falls before the start date.
      startUrls() {
        return [`${origin}/orders`];
      },

      detect(doc, loc) {
        if (loc.pathname.startsWith(loginPath) || /\/login\b/.test(loc.pathname)) return 'login';
        if (/\/blocked/.test(loc.pathname) || doc.querySelector('#px-captcha') || /robot or human/i.test(doc.title)) {
          return 'challenge';
        }
        // A code sent by text or email. Page text is only trusted when no orders are
        // showing, so ordinary wording on an order page can't set this off.
        if (VERIFY_PATH.test(loc.pathname)) return 'verify';
        if (doc.body && orderMarkers(doc).size === 0 && VERIFY_TEXT.test(text(doc.body))) return 'verify';
        return null;
      },

      extractList(doc, ctx) {
        const markers = orderMarkers(doc);
        const elements = [...markers.values()];
        const orders = [];
        for (const [orderId, marker] of markers) {
          const card = cardFor(marker, (el) => elements.some((other) => other !== marker && el.contains(other)));
          const cardText = text(card);
          const dateMatch = cardText.match(DATED_ORDER) || cardText.match(ORDER_ON) || cardText.match(ANY_DATE);
          const total = labeledMoney(card, /^(order )?total\b/i);
          const status = cardText.match(STATUS);
          const detailUrl = detailUrlFor(orderId);
          orders.push({
            orderId,
            date: dateMatch ? OHE.parseDate(dateMatch[1] || dateMatch[0], ctx.today) : null,
            total: total ? total.amount : undefined,
            currency: total ? total.currency : undefined,
            status: status ? status[0].trim() : undefined,
            url: detailUrl,
            detailUrl,
            items: readItems(card, false),
          });
        }
        return { orders };
      },

      nextElement(doc) {
        return doc.querySelector(
          '[data-automation-id="next-pages-button"], [data-testid="next-page"], a[aria-label="Next Page" i], button[aria-label="Next Page" i], a[aria-label="Next" i], button[aria-label="Next" i]'
        );
      },

      extractDetail(doc) {
        const main = doc.querySelector('main') || doc.body;
        // List pages can leave out the year, so the full date here corrects them.
        const heading = [...main.querySelectorAll('h1')].map(text).find((t) => /\b\d{4}\b/.test(t));
        const date = heading ? OHE.parseDate(heading) : null;
        return {
          ...summary(main),
          ...OHE.dom.deliveryAddress(main),
          ...(date ? { date } : {}),
          payment: readCardPayments(main) || payment(main),
          items: readItems(main, true),
        };
      },
    };
  };
})(globalThis);

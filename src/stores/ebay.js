(function (root) {
  const OHE = root.OHE;
  const { text, labeled, labeledMoney, summary, cardFor, rowFor, absolute } = OHE.dom;
  const ORIGIN = 'https://www.ebay.com';
  const LIST_URL = `${ORIGIN}/mye/myebay/purchase`;
  const ORDER_ID_TEXT = /\b(\d{2}-\d{5}-\d{5})\b/;
  const STATUS = /\b(Delivered|Shipped|Canceled|Cancelled|Returned|Refunded|Paid|In transit|Out for delivery)\b[^$]{0,30}/i;

  const orderIdFromHref = (href) => (href.match(/[?&]orderid=([\w-]+)/i) || [])[1] || null;
  const itemKey = (href) => (href.match(/\/itm\/(?:[^/?]+\/)?(\d+)/) || [])[1] || href.split('?')[0];

  function readItems(root) {
    const links = [...root.querySelectorAll('a[href*="/itm/"]')];
    const items = new Map();
    for (const link of links) {
      const name = text(link);
      const href = link.getAttribute('href');
      if (!name || items.has(itemKey(href))) continue;
      const key = itemKey(href);
      const row = rowFor(link, (el) => links.some((l) => l !== link && el.contains(l) && itemKey(l.getAttribute('href')) !== key));
      const item = { name, url: absolute(href, ORIGIN) };
      const price = OHE.parseMoney(text(row));
      if (price) item.price = price.amount;
      const qty = text(row).match(/\b(?:Qty|Quantity):?\s*(\d+)/i);
      if (qty) item.quantity = Number(qty[1]);
      const seller = row.querySelector('a[href*="/usr/"], a[href*="/str/"]');
      if (seller) item.seller = text(seller);
      items.set(key, item);
    }
    return [...items.values()];
  }

  // eBay filters by how many years ago, using these names.
  const YEAR_TERMS = [
    'CURRENT_YEAR', 'LAST_YEAR', 'TWO_YEARS_AGO', 'THREE_YEARS_AGO', 'FOUR_YEARS_AGO', 'FIVE_YEARS_AGO',
    'SIX_YEARS_AGO', 'SEVEN_YEARS_AGO', 'EIGHT_YEARS_AGO', 'NINE_YEARS_AGO', 'TEN_YEARS_AGO', 'ELEVEN_YEARS_AGO',
    'TWELVE_YEARS_AGO', 'THIRTEEN_YEARS_AGO', 'FOURTEEN_YEARS_AGO', 'FIFTEEN_YEARS_AGO', 'SIXTEEN_YEARS_AGO',
    'SEVENTEEN_YEARS_AGO', 'EIGHTEEN_YEARS_AGO', 'NINETEEN_YEARS_AGO', 'TWENTY_YEARS_AGO', 'TWENTY_ONE_YEARS_AGO',
    'TWENTY_TWO_YEARS_AGO',
  ];

  function termsFor(range, today) {
    const thisYear = +today.slice(0, 4);
    if (!range.from) {
      const newest = range.to ? thisYear - +range.to.slice(0, 4) : 0;
      return YEAR_TERMS.slice(Math.max(newest, 0));
    }
    return OHE.yearsIn(range, today)
      .map((year) => YEAR_TERMS[thisYear - year])
      .filter(Boolean);
  }

  const spanText = (message) => (message && message.textSpans ? message.textSpans.map((s) => s.text).join('') : '');

  // Order date and total are label/value pairs in secondaryMessage.
  function messageAfter(messages, labelRe, fallbackIndex) {
    const at = messages.findIndex((m) => labelRe.test(spanText(m)));
    return spanText(messages[at >= 0 ? at + 1 : fallbackIndex]);
  }

  function parseApi(json, ctx) {
    const river = json && json.modules && json.modules.RIVER && json.modules.RIVER[0];
    const entries = (river && river.data && river.data.items) || [];
    const orders = new Map();
    for (const entry of entries) {
      const messages = entry.secondaryMessage || [];
      const action = (entry.actions || []).find((a) => a.action && a.action.name === 'VIEW_ORDER_DETAILS');
      const url = action ? action.action.URL : undefined;
      const total = OHE.parseMoney(messageAfter(messages, /order total/i, 3));
      for (const card of entry.itemCards || []) {
        const info = card.__myb || {};
        if (!info.orderId) continue;
        if (!orders.has(info.orderId)) {
          orders.set(info.orderId, {
            orderId: info.orderId,
            date: OHE.parseDate(messageAfter(messages, /order date/i, 1), ctx.today),
            total: total ? total.amount : undefined,
            currency: total ? total.currency : undefined,
            url,
            detailUrl: url,
            items: [],
          });
        }
        const value = card.additionalPrice && card.additionalPrice.value;
        const quantity = (card.aspectValuesList || [])
          .map(spanText)
          .map((t) => t.match(/^quantity\s*:\s*(\d+)/i))
          .find(Boolean);
        orders.get(info.orderId).items.push({
          name: (card.image && card.image.title) || '',
          price: value && typeof value.value === 'number' ? value.value : undefined,
          quantity: quantity ? Number(quantity[1]) : 1,
          seller: (info.sellerInfo && spanText(info.sellerInfo[1])) || undefined,
          url: card.listingId ? `${ORIGIN}/itm/${card.listingId}` : undefined,
        });
      }
    }
    return { orders: [...orders.values()], more: entries.length > 0 };
  }

  function orderCards(doc) {
    const classed = [...doc.querySelectorAll('.m-order-card, [class*="order-card"]')].filter(
      (el) => !(el.parentElement && el.parentElement.closest('.m-order-card, [class*="order-card"]'))
    );
    if (classed.length) return classed;
    // Fall back to grouping by the "order details" links when class names change.
    const links = [...doc.querySelectorAll('a[href*="orderId=" i]')];
    const seen = new Set();
    return links
      .filter((link) => {
        const id = orderIdFromHref(link.getAttribute('href'));
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((link) =>
        cardFor(link, (el) =>
          links.some((l) => el.contains(l) && orderIdFromHref(l.getAttribute('href')) !== orderIdFromHref(link.getAttribute('href')))
        )
      );
  }

  OHE.registerStore({
    id: 'ebay',
    name: 'eBay',
    ordersUrl: LIST_URL,
    hosts: ['www.ebay.com', 'order.ebay.com'],

    // eBay's purchase page loads its orders from this JSON endpoint. It is not a
    // public API and may change; if it fails, the crawler reads the pages instead.
    listApi: {
      terms: termsFor,
      url: (term, page) =>
        `${ORIGIN}/mye/myebay/ajax/v2/purchase/mp/get?filter=year_filter:${term}&page=${page}` +
        '&modules=ALL_TRANSACTIONS&moduleId=122164&pg=purchase&mp=purchase-module-v2',
      parse: parseApi,
    },

    startUrls(range, today) {
      return termsFor(range, today).map((term) => `${LIST_URL}?filter=year_filter:${term}`);
    },

    detect(doc, loc) {
      if (/^signin\./.test(loc.hostname) || /\/signin\//.test(loc.pathname)) return 'login';
      // Judged by URL only: eBay's normal pages can contain captcha elements
      // even when no check is being asked for.
      if (/captcha/i.test(loc.pathname)) return 'challenge';
      return null;
    },

    extractList(doc, ctx) {
      const orders = [];
      for (const card of orderCards(doc)) {
        const links = [...card.querySelectorAll('a[href*="orderId=" i]')];
        const orderId =
          (labeled(card, /^order number\b/i) || '').trim().split(/\s/)[0] ||
          (links[0] && orderIdFromHref(links[0].getAttribute('href'))) ||
          (text(card).match(ORDER_ID_TEXT) || [])[1];
        if (!orderId) continue;
        const total = labeledMoney(card, /^order total\b/i);
        const status = text(card).match(STATUS);
        const detailUrl = links[0] ? absolute(links[0].getAttribute('href'), ORIGIN) : undefined;
        orders.push({
          orderId,
          date: OHE.parseDate(labeled(card, /^order date\b/i) || text(card), ctx.today),
          total: total ? total.amount : undefined,
          currency: total ? total.currency : undefined,
          status: status ? status[0].trim() : undefined,
          url: detailUrl,
          detailUrl,
          items: readItems(card),
        });
      }
      return { orders };
    },

    nextElement(doc) {
      return doc.querySelector('a.pagination__next:not([aria-disabled="true"]), a[aria-label*="next page" i]');
    },

    extractDetail(doc) {
      // Item rows from the list are richer than this page's, so they aren't replaced.
      const main = doc.querySelector('main') || doc.body;
      return { ...summary(main), ...OHE.dom.deliveryAddress(main), payment: OHE.dom.payment(main) };
    },
  });
})(globalThis);

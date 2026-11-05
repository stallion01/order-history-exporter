(function (root) {
  const OHE = root.OHE;
  const { text, labeled, labeledMoney, summary, payment, rowFor, absolute } = OHE.dom;
  const ORIGIN = 'https://www.amazon.com';
  const ORDER_ID = /\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/;
  const ITEM_LINK = 'a[href*="/dp/"], a[href*="/gp/product/"]';
  const NOT_A_TITLE = /^(buy it again|view your item|write a product review|track package|return|problem with)/i;

  const listUrl = (year) => `${ORIGIN}/your-orders/orders?timeFilter=year-${year}`;
  const asinOf = (href) => (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) || [])[1] || href;

  function readItems(root, withPrices) {
    const links = [...root.querySelectorAll(ITEM_LINK)];
    const isOtherItem = (el, self) => links.some((l) => l !== self && el.contains(l) && asinOf(l.href) !== asinOf(self.href));
    const items = new Map();
    for (const link of links) {
      const name = text(link);
      if (!name || NOT_A_TITLE.test(name)) continue;
      const key = asinOf(link.href);
      if (items.has(key)) continue;
      const item = { name, url: absolute(link.getAttribute('href'), ORIGIN) };
      const row = rowFor(link, (el) => isOtherItem(el, link));
      const qty = row.querySelector('.product-image__qty');
      if (qty && /^\d+$/.test(text(qty))) item.quantity = Number(text(qty));
      if (withPrices) {
        const priceEl = row.querySelector('[data-component="unitPrice"] .a-offscreen, .a-price .a-offscreen, .a-color-price');
        const price = OHE.parseMoney(text(priceEl) || text(row));
        if (price) item.price = price.amount;
        const sold = text(row).match(/Sold by:?\s+(.+?)(?:\s+Return|\s+Supplied|\s+Condition|\s+\$|$)/i);
        if (sold) item.seller = sold[1].trim();
      }
      items.set(key, item);
    }
    return [...items.values()];
  }

  OHE.registerStore({
    id: 'amazon',
    name: 'Amazon',
    ordersUrl: `${ORIGIN}/your-orders/orders`,
    hosts: ['www.amazon.com'],

    // Amazon filters by calendar year, so a range maps onto its year listings.
    startUrls(range, today) {
      return OHE.yearsIn(range, today).map(listUrl);
    },

    detect(doc, loc) {
      if (/\/ap\/(signin|mfa|cvf)/.test(loc.pathname)) return 'login';
      if (/validateCaptcha/.test(loc.pathname) || doc.querySelector('form[action*="validateCaptcha"]')) return 'challenge';
      return null;
    },

    extractList(doc, ctx) {
      const orders = [];
      for (const card of doc.querySelectorAll('.order-card, .js-order-card')) {
        if (card.parentElement && card.parentElement.closest('.order-card, .js-order-card')) continue;
        const idMatch = text(card.querySelector('.yohtmlc-order-id')).match(ORDER_ID) || text(card).match(ORDER_ID);
        if (!idMatch) continue;
        const orderId = idMatch[1];
        const total = labeledMoney(card, /^total\b/i);
        const detailUrl = `${ORIGIN}/gp/your-account/order-details?orderID=${orderId}`;
        orders.push({
          orderId,
          date: OHE.parseDate(labeled(card, /^order placed\b/i), ctx.today),
          total: total ? total.amount : undefined,
          currency: total ? total.currency : undefined,
          status: text(card.querySelector('.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText')) || undefined,
          url: detailUrl,
          detailUrl,
          items: readItems(card, false),
        });
      }
      // With no start date, every year the account offers gets listed.
      const enqueue = ctx.range && ctx.range.from
        ? []
        : [...doc.querySelectorAll('option[value^="year-"]')].map((o) => listUrl(o.value.replace('year-', '')));
      return { orders, enqueue };
    },

    nextElement(doc) {
      return doc.querySelector('.a-pagination .a-last:not(.a-disabled) a');
    },

    extractDetail(doc) {
      const root = doc.querySelector('#orderDetails') || doc.querySelector('main') || doc.body;
      const totals = doc.querySelector('[id*="od-subtotals"]') || root;
      const addressBlock = doc.querySelector('[data-component="shippingAddress"]');
      const address = (addressBlock && OHE.dom.parseAddress(text(addressBlock))) || OHE.dom.deliveryAddress(doc.body);
      return { ...summary(totals), ...address, payment: payment(doc.body), items: readItems(root, true) };
    },
  });
})(globalThis);

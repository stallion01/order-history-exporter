(function (root) {
  const OHE = root.OHE;
  const { text, labeled, labeledMoney, summary, absolute } = OHE.dom;
  const ORIGIN = 'https://secure.newegg.com';
  const LIST_URL = `${ORIGIN}/orders/list`;
  const RECENT_DAYS = 120;

  // Newegg's data requests are signed, so the date filter is set through the page's own dropdown.
  const dateSelect = (doc) =>
    [...doc.querySelectorAll('select')].find((s) => [...s.options].some((o) => /^Year \d{4}/.test(o.text.trim())));

  function daysBefore(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function readItems(root, withPrices) {
    const items = [];
    for (const cell of root.querySelectorAll('.item-cell')) {
      const title = cell.querySelector('a.item-title');
      if (!title) continue; // summary rows use the same cell class
      const item = { name: text(title), url: absolute(title.getAttribute('href'), 'https://www.newegg.com') };
      const qty = text(cell.querySelector('.item-qty')).match(/\d+/);
      if (qty) item.quantity = Number(qty[0]);
      const seller = cell.querySelector('.item-note a.link-text');
      if (seller) item.seller = text(seller);
      if (withPrices) {
        const price = OHE.parseMoney(text(cell.querySelector('.price-current')));
        if (price) item.price = price.amount;
      }
      items.push(item);
    }
    return items;
  }

  function extractList(doc, ctx) {
    const orders = [];
    for (const card of doc.querySelectorAll('.order-list .order')) {
      const orderId = (labeled(card, /^order\s*#/i) || '').match(/\d+/);
      if (!orderId) continue;
      const total = labeledMoney(card, /^order total\b/i);
      const link = card.querySelector('a[href*="orders/cart"]');
      const detailUrl = link ? absolute(link.getAttribute('href'), ORIGIN) : undefined;
      orders.push({
        orderId: orderId[0],
        date: OHE.parseDate(labeled(card, /^order date\b/i), ctx.today),
        total: total ? total.amount : undefined,
        currency: total ? total.currency : undefined,
        status: text(card.querySelector('.order-message-note')) || undefined,
        url: detailUrl,
        detailUrl,
        items: readItems(card, false),
      });
    }
    return { orders };
  }

  OHE.registerStore({
    id: 'newegg',
    name: 'Newegg',
    ordersUrl: LIST_URL,
    hosts: ['secure.newegg.com'],

    startUrls() {
      return [LIST_URL];
    },

    detect(doc, loc) {
      if (/\/(identity|signin|login)\b/i.test(loc.pathname)) return 'login';
      if (/areyouahuman|captcha/i.test(loc.pathname + loc.hostname)) return 'challenge';
      return null;
    },

    views: {
      // "Recent Orders" holds only the latest few, so the years in range are read as well.
      list(doc, ctx) {
        const select = dateSelect(doc);
        if (!select) return null;
        const { from, to } = ctx.range;
        const values = [...select.options].map((o) => o.value);
        const views = [null];
        if (values.includes(String(RECENT_DAYS)) && (!to || to >= daysBefore(ctx.today, RECENT_DAYS))) {
          views.push(String(RECENT_DAYS));
        }
        for (const option of select.options) {
          const year = (option.text.trim().match(/^Year (\d{4})/) || [])[1];
          if (year && (!from || year >= from.slice(0, 4)) && (!to || year <= to.slice(0, 4))) views.push(option.value);
        }
        return views;
      },

      async apply(doc, view, ctx) {
        const select = await OHE.waitFor(() => dateSelect(doc), 10000);
        if (!select) return false;
        const before = extractList(doc, ctx).orders.map((o) => o.orderId).join();
        const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value').set;
        setValue.call(select, view);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // The list may legitimately stay the same, so running out of time is not a failure.
        await OHE.waitFor(() => extractList(doc, ctx).orders.map((o) => o.orderId).join() !== before, 5000);
        return true;
      },
    },

    extractList,

    nextElement(doc) {
      return doc.querySelector(
        '.list-tool-pagination button[title="Next" i], .btn-group-cell button[title="Next" i], .btn-group-cell a[title="Next" i], button[aria-label="Next" i]'
      );
    },

    extractDetail(doc) {
      const main = doc.querySelector('.page-section-inner') || doc.body;
      // A details page covers a whole checkout, which can hold several orders. Its
      // totals and items then span all of them, so only shared details are taken.
      const orderTags = [...main.querySelectorAll('.order-item-tag')].filter((el) => /^Order \d+/.test(text(el)));
      const receipt = [...main.querySelectorAll('.fieldset-legend')]
        .map((el) => (text(el).match(/^([A-Za-z ]{2,20}) Receipt$/) || [])[1])
        .find(Boolean);
      // The card brand is only in the icon's class, such as "card-icon type-discover".
      const icon = main.querySelector('.card-icon[class*="type-"]');
      const brand = icon ? (String(icon.className).match(/\btype-([a-z]+)/i) || [])[1] : null;
      const found = OHE.dom.payment(main);
      const named = found && brand ? found.replace(/^Card ending/, `${brand.charAt(0).toUpperCase()}${brand.slice(1)} ending`) : found;
      const shared = { ...OHE.dom.deliveryAddress(main), payment: named || receipt };
      if (orderTags.length > 1) return shared;
      return { ...summary(main), ...shared, items: readItems(main, true) };
    },
  });
})(globalThis);

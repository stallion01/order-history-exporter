(function (root) {
  const OHE = root.OHE;
  const { text, summary, absolute } = OHE.dom;
  const ORIGIN = 'https://www.homedepot.com';
  const LIST_URL = `${ORIGIN}/myaccount/purchase-history`;
  const ORDER_LINK = 'tbody a[href*="order-details"]';
  const DEFAULT_MONTHS = 25;
  const WIDEST_VIEW = 'Last 7 Years';
  // Used only if the table's headings can't be read.
  const FALLBACK_COLUMNS = { date: 3, payment: 5, total: 7, products: 1 };

  const button = (doc, pattern) => [...doc.querySelectorAll('button')].find((b) => pattern.test(text(b)));

  function columnIndexes(table) {
    const headings = [...table.querySelectorAll('thead th')].map((th) => text(th).toLowerCase());
    const find = (word, fallback) => {
      const index = headings.findIndex((h) => h === word || h.startsWith(word));
      return index >= 0 ? index : fallback;
    };
    return {
      date: find('date', FALLBACK_COLUMNS.date),
      payment: find('payment', FALLBACK_COLUMNS.payment),
      total: find('total', FALLBACK_COLUMNS.total),
      products: find('product', FALLBACK_COLUMNS.products),
    };
  }

  // The card brand is only in the logo's alt text, next to "- 1234".
  function readPayment(cell) {
    if (!cell) return undefined;
    const digits = text(cell).match(/(\d{4})\s*$/);
    const logo = cell.querySelector('img[alt]');
    // Logo text looks like "mastercard" or "visa-card".
    const alt = logo ? logo.getAttribute('alt').trim().replace(/[-_]card$/i, '').replace(/[-_]/g, ' ') : '';
    const brand = /^[A-Za-z][A-Za-z ']{1,30}$/.test(alt) ? alt.charAt(0).toUpperCase() + alt.slice(1) : '';
    if (digits) return `${brand || 'Card'} ending ${digits[1]}`;
    return brand || undefined;
  }

  function extractList(doc, ctx) {
    const orders = [];
    const links = doc.querySelectorAll(ORDER_LINK);
    if (!links.length) return { orders };
    const columns = columnIndexes(links[0].closest('table'));
    for (const link of links) {
      const row = link.closest('tr');
      const orderId = text(link).replace(/^#\s*/, '');
      if (!row || !orderId) continue;
      const cell = (name) => row.children[columns[name]];
      const total = OHE.parseMoney(text(cell('total')));
      const url = absolute(link.getAttribute('href'), ORIGIN);
      const productCell = cell('products');
      orders.push({
        orderId,
        date: OHE.parseDate(text(cell('date')), ctx.today),
        total: total ? total.amount : undefined,
        currency: total ? total.currency : undefined,
        payment: readPayment(cell('payment')),
        url,
        detailUrl: url,
        // Thumbnails only; the order's own page has the full list.
        items: productCell
          ? [...productCell.querySelectorAll('img[alt]')].map((img) => ({ name: img.getAttribute('alt').trim() })).filter((i) => i.name)
          : [],
      });
    }
    return { orders };
  }

  function readDetailItems(root) {
    const qtyLabels = [...root.querySelectorAll('p')].filter((p) => /^Qty:\s*\d+/i.test(text(p)));
    const items = [];
    for (const label of qtyLabels) {
      // Widen to the item's card, stopping before another item or a section heading.
      let card = label;
      for (let up = 0; up < 4 && card.parentElement; up++) {
        const parent = card.parentElement;
        if (parent.querySelector('h1, h2, h3') || qtyLabels.some((q) => q !== label && parent.contains(q))) break;
        card = parent;
      }
      const name = [...card.querySelectorAll('span')]
        .filter((span) => !span.children.length && !span.closest('button'))
        .map(text)
        .sort((a, b) => b.length - a.length)[0];
      if (!name) continue;
      const cardText = text(card);
      const unit = cardText.match(/\(\s*\$\s*([\d,]+(?:\.\d{1,2})?)\s*\/\s*item\s*\)/i);
      const line = OHE.parseMoney(text(label.nextElementSibling)) || OHE.parseMoney(cardText);
      const price = unit ? Number(unit[1].replace(/,/g, '')) : line ? line.amount : undefined;
      items.push({ name, quantity: Number(text(label).match(/\d+/)[0]), price });
    }
    return items;
  }

  OHE.registerStore({
    id: 'homedepot',
    name: 'Home Depot',
    ordersUrl: LIST_URL,
    hosts: ['www.homedepot.com'],

    startUrls() {
      return [LIST_URL];
    },

    detect(doc, loc) {
      if (/\/(auth|signin|login)\b/i.test(loc.pathname)) return 'login';
      if (/captcha|blocked/i.test(loc.pathname)) return 'challenge';
      return null;
    },

    views: {
      list(doc, ctx) {
        if (!button(doc, /^Date Placed:/i)) return null;
        // The list only reads the table layout, so switch to it if needed.
        if (!doc.querySelector(ORDER_LINK)) {
          const tableView = button(doc, /^Table View$/i);
          if (tableView) tableView.click();
          return null;
        }
        const from = ctx.range.from;
        if (!from) return [WIDEST_VIEW];
        const [y, m, d] = ctx.today.split('-').map(Number);
        const edge = new Date(y, m - 1 - DEFAULT_MONTHS, d);
        const cutoff = `${edge.getFullYear()}-${String(edge.getMonth() + 1).padStart(2, '0')}-${String(edge.getDate()).padStart(2, '0')}`;
        return from < cutoff ? [WIDEST_VIEW] : [null];
      },

      async apply(doc, view) {
        const opener = await OHE.waitFor(() => button(doc, /^Date Placed:/i), 15000);
        if (!opener) return false;
        await OHE.waitFor(() => doc.querySelector(ORDER_LINK), 10000);
        opener.click();
        const pattern = new RegExp(`^${view}\\b`, 'i');
        const option = await OHE.waitFor(() => button(doc, pattern), 5000);
        if (!option) return false;
        option.click();
        const confirm = await OHE.waitFor(() => button(doc, /^View Results$/i), 5000);
        if (!confirm) return false;
        confirm.click();
        const shown = await OHE.waitFor(
          () => (button(doc, /^Date Placed:/i) || { textContent: '' }).textContent.includes(view),
          8000
        );
        if (!shown) return false;
        // The first page can look identical under a wider filter, so there is no change
        // to wait for. This gives the new results time to arrive.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return true;
      },
    },

    extractList,

    nextElement(doc) {
      return doc.querySelector('button[aria-label="Skip to Next Page"]');
    },

    extractDetail(doc) {
      const main = doc.querySelector('main') || doc.querySelector('#root') || doc.body;
      // The list often leaves Payment empty, but this page has the logo and digits
      // in the block after the label's own container.
      const label = [...main.querySelectorAll('p')].find((p) => /^Payment:?$/i.test(text(p)));
      const payment = label ? readPayment(label.parentElement.nextElementSibling) : undefined;
      return { ...summary(main), ...OHE.dom.deliveryAddress(main), payment, items: readDetailItems(main) };
    },
  });
})(globalThis);

# Adding or fixing a store

Each store is one small file in `src/stores/`. To add one:

1. Create `src/stores/yourstore.js` and call `OHE.registerStore({...})`.
2. Add the file to `STORE_FILES` in `src/stores/index.js`.
3. Add the store's hosts to `host_permissions` in `manifest.json`.
4. Add a synthetic fixture in `tests/fixtures/` and a test in `tests/unit.test.js`.

Never commit a page saved from a real account. Write fixtures by hand with made-up data.

## Adapter interface

```js
OHE.registerStore({
  id: 'yourstore',
  name: 'Your Store',
  ordersUrl: 'https://www.yourstore.com/orders',
  hosts: ['www.yourstore.com'], // the crawler won't follow links to other hosts

  // Where listing starts. Return several URLs if the store filters by year.
  startUrls(range, today) {
    return ['https://www.yourstore.com/orders'];
  },

  // 'login', 'challenge' (CAPTCHA or bot check), or null. Pauses the run for the user.
  detect(doc, loc) {
    return loc.pathname.startsWith('/login') ? 'login' : null;
  },

  // Called repeatedly until it finds orders, so JavaScript-rendered pages work.
  extractList(doc, ctx) {
    return {
      orders: [
        {
          orderId: '123',                       // required and unique within the store
          date: OHE.parseDate(text, ctx.today), // YYYY-MM-DD
          total: 12.34,
          currency: 'USD',
          status: 'Delivered',
          url: 'https://...',                   // link shown in the CSV
          detailUrl: 'https://...',             // optional page for extractDetail
          items: [{ name: '', quantity: 1, price: 0, seller: '', url: '' }],
        },
      ],
      enqueue: [], // optional: more listing URLs found on this page
    };
  },

  // The next-page link or button, or null. Links are followed and buttons are clicked.
  nextElement(doc) {
    return doc.querySelector('a[rel="next"]');
  },

  // Optional: extra fields from an order's own page.
  extractDetail(doc, order, ctx) {
    return { ...OHE.dom.summary(doc.body), items: [] };
  },

  // Optional: a same-origin JSON endpoint, tried before reading pages.
  // listApi: { terms(range, today), url(term, page), parse(json, ctx) => ({ orders, more }) },

  // Optional: for a list filtered by a control on the page (a tab, a date menu) rather
  // than by its address. list returns the settings a range needs, or null until the
  // controls exist; apply sets one and resolves true once the list shows it. Each view
  // starts from ordersUrl and is then read like any list. See homedepot.js and costco.js.
  // views: { list(doc, ctx) => ['2024', '2023'], async apply(doc, view) => true },

  // Optional: for details that open in place, such as a popup on the list page, so an
  // order has no page of its own. Set detailUrl to the list page. openDetail is called
  // repeatedly after that page loads: each call takes one step towards showing the
  // order (order.orderId, order.date) and returns true once it is showing. extractDetail
  // then reads it, and must return null for any other order's details. See costco.js.
  // openDetail(doc, order, ctx) { return false; },
});
```

## Writing parsers that last

Class names change far more often than the words on the page, so prefer these, in order:

1. A JSON endpoint the site itself uses.
2. Links and IDs, such as `a[href*="/orders/"]` and `data-testid`.
3. Visible labels, using `OHE.dom.labeled(card, /^order date\b/i)` and `labeledMoney`.
4. Class names, as a last resort.

`OHE.dom.cardFor` finds an order's card without knowing its class, and `OHE.dom.summary` reads subtotal, tax, shipping and total rows.

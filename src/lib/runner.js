// Runs inside a store tab. Waits for the page to render, calls the store's
// parser, and reports plain data back to the crawler.
(function (root) {
  const OHE = root.OHE;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const EMPTY_RE =
    /\b(no orders|no purchases|have not placed|haven't placed|don't have any (orders|purchases)|no results)\b/i;
  const EMPTY_WAIT_MS = 2500;

  const fingerprint = (orders) => orders.map((o) => o.orderId).join('|');

  function isDisabled(el) {
    return (
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      /\bdisabled\b/.test(el.className && el.className.baseVal === undefined ? el.className : '')
    );
  }

  function describeNext(store) {
    const el = store.nextElement ? store.nextElement(document) : null;
    if (!el || isDisabled(el)) return null;
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
      return { url: new URL(href, location.href).href };
    }
    return { click: true };
  }

  function listResult(store, extracted, emptyPage) {
    return {
      status: 'ok',
      empty: Boolean(emptyPage),
      orders: extracted.orders.map((o) => OHE.normalizeOrder(o, store.id)),
      enqueue: extracted.enqueue || [],
      next: describeNext(store),
      fingerprint: fingerprint(extracted.orders),
    };
  }

  // After the user presses Continue on a security check, their word beats our
  // detection: a mistaken check must not trap them in a loop. If a check really
  // is still there, parsing fails and the run reports an unreadable page instead.
  function blockedStatus(store, ignoreChallenge) {
    const blocked = store.detect(document, location);
    return (blocked === 'challenge' || blocked === 'verify') && ignoreChallenge ? null : blocked;
  }

  OHE.run = async function run({ storeId, mode = 'list', order, notFingerprint, range, today, ignoreChallenge, timeoutMs = 15000 }) {
    const store = OHE.stores[storeId];
    const ctx = { today, range: range || {} };
    const started = Date.now();
    let lastFingerprint = null;

    for (;;) {
      const blocked = blockedStatus(store, ignoreChallenge);
      if (blocked) return { status: blocked };
      const elapsed = Date.now() - started;

      if (document.readyState !== 'loading') {
        if (mode === 'detail') {
          const patch = store.extractDetail(document, order, ctx);
          if (patch && (patch.total !== undefined || patch.payment || (patch.items && patch.items.length))) {
            await sleep(300); // let late-rendering rows arrive, then read once more
            return { status: 'ok', patch: store.extractDetail(document, order, ctx) || patch };
          }
        } else {
          const extracted = store.extractList(document, ctx);
          lastFingerprint = fingerprint(extracted.orders);
          if (extracted.orders.length && lastFingerprint !== notFingerprint) {
            await sleep(300);
            return listResult(store, store.extractList(document, ctx), false);
          }
          if (!extracted.orders.length && elapsed > EMPTY_WAIT_MS && EMPTY_RE.test(OHE.dom.text(document.body))) {
            return listResult(store, extracted, true);
          }
        }
      }

      if (elapsed > timeoutMs) break;
      await sleep(400);
    }

    if (mode === 'list' && notFingerprint && lastFingerprint === notFingerprint) return { status: 'stale' };
    return { status: 'unparsed' };
  };

  // Reads one page from a store's JSON endpoint using the page's own session.
  // Any surprise reports 'unparsed', and the crawler falls back to reading pages.
  OHE.runApi = async function runApi({ storeId, term, page, today, range, ignoreChallenge }) {
    const store = OHE.stores[storeId];
    const blocked = blockedStatus(store, ignoreChallenge);
    if (blocked) return { status: blocked };
    try {
      const response = await fetch(store.listApi.url(term, page), { credentials: 'include' });
      if (!response.ok) return { status: 'unparsed' };
      const parsed = store.listApi.parse(await response.json(), { today, range: range || {} });
      return {
        status: 'ok',
        orders: parsed.orders.map((o) => OHE.normalizeOrder(o, store.id)),
        more: parsed.more,
      };
    } catch (_e) {
      return { status: 'unparsed' };
    }
  };

  // Which filter settings to read for this range, once the page's controls exist.
  OHE.listViews = async function listViews({ storeId, range, today, ignoreChallenge, timeoutMs = 15000 }) {
    const store = OHE.stores[storeId];
    const started = Date.now();
    for (;;) {
      const blocked = blockedStatus(store, ignoreChallenge);
      if (blocked) return { status: blocked };
      if (document.readyState !== 'loading') {
        const views = store.views.list(document, { today, range: range || {} });
        if (views) return { status: 'ok', views };
      }
      if (Date.now() - started > timeoutMs) return { status: 'unparsed' };
      await sleep(400);
    }
  };

  // Sets a filter on the page and waits for the list to reflect it.
  OHE.applyView = async function applyView({ storeId, view, today, ignoreChallenge }) {
    const store = OHE.stores[storeId];
    const blocked = blockedStatus(store, ignoreChallenge);
    if (blocked) return { status: blocked };
    const applied = await store.views.apply(document, view, { today, range: {} });
    return { status: applied ? 'ok' : 'unparsed' };
  };

  OHE.clickNext = function clickNext({ storeId }) {
    const el = OHE.stores[storeId].nextElement(document);
    if (!el) return false;
    el.click();
    return true;
  };

  /* ---------- Redacted diagnostics ---------- */

  // Words kept readable so a maintainer can see which labels the page uses.
  const SAFE_WORDS =
    /^(address|ship|deliver|delivers|payment|payments|method|methods|ending|order|orders|placed|date|total|subtotal|tax|shipping|delivery|delivered|details|view|number|item|items|qty|quantity|price|next|previous|page|purchase|purchases|history|status|seller|sold|by|on|arrived|shipped|returned|canceled|cancelled|refunded|free|grand|estimated|sales|buy|again|invoice|receipt)$/i;
  const KEEP_ATTRS = new Set(['class', 'id', 'role', 'data-testid', 'data-automation-id', 'data-component']);

  const redactText = (s) =>
    s.replace(/[^\s]+/g, (word) => {
      const bare = word.replace(/[^A-Za-z]/g, '');
      if (bare && SAFE_WORDS.test(bare) && !/\d/.test(word)) return word;
      return word.replace(/[A-Za-z]/g, 'x').replace(/\d/g, '0');
    });

  // Page structure with personal details removed: all text is masked except common
  // order labels, digits are zeroed, and hrefs keep only their masked path.
  OHE.snapshot = function snapshot() {
    const doc = document;
    const clone = doc.documentElement.cloneNode(true);
    clone
      .querySelectorAll('script,style,svg,noscript,iframe,link,meta,template,input,textarea,select,canvas,video')
      .forEach((n) => n.remove());
    const walker = doc.createTreeWalker(clone, 4);
    let node;
    while ((node = walker.nextNode())) node.nodeValue = redactText(node.nodeValue);
    clone.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (attr.name === 'href') {
          const path = (attr.value.split(/[?#]/)[0] || '').replace(/^[a-z]+:\/\/[^/]+/i, '');
          el.setAttribute('href', path.replace(/\d/g, '0').replace(/[A-Za-z0-9_-]{16,}/g, 'x'));
        } else if (KEEP_ATTRS.has(attr.name)) {
          el.setAttribute(attr.name, attr.value.replace(/\d{3,}/g, '000'));
        } else {
          el.removeAttribute(attr.name);
        }
      }
    });
    return clone.outerHTML.replace(/\s{2,}/g, ' ').slice(0, 1_500_000);
  };
})(globalThis);

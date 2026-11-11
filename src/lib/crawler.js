// Runs in the exporter page. Drives one store tab through its order pages.
(function (root) {
  const OHE = root.OHE;
  const MAX_PAGES = 500;
  const LOAD_TIMEOUT_MS = 45000;

  // Waiting goes through the service worker; see background.js for why.
  function sleep(ms) {
    return chrome.runtime.sendMessage({ type: 'sleep', ms }).catch(
      () => new Promise((resolve) => setTimeout(resolve, ms))
    );
  }
  const politeDelay = () => sleep(1200 + Math.random() * 1300);

  function navigate(tabId, url) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          finish();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish();
        resolve(); // a slow page may still be usable; the parser decides
      }, LOAD_TIMEOUT_MS);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url }).catch((err) => {
        finish();
        reject(err);
      });
    });
  }

  // Calls a function from runner.js in the tab. Pages the extension may not
  // access (for example a sign-in page on another host) report 'offhost'.
  async function callInTab(tabId, fnName, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: OHE.CONTENT_FILES });
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (name, fnArgs) => globalThis.OHE[name](fnArgs),
          args: [fnName, args],
        });
        if (injected && injected.result !== undefined && injected.result !== null) return injected.result;
        throw new Error('Page navigated away before it replied');
      } catch (err) {
        if (/cannot access|must request permission|showing error page/i.test(err.message)) return { status: 'offhost' };
        if (attempt >= 2) throw err;
        await sleep(1500); // usually a redirect in progress
      }
    }
  }

  // The parts both crawl phases share: paused reads and host checks.
  function session(store, tabId, options, hooks) {
    const { range, today, isStopped } = options;
    return {
      allowedHost(url) {
        try {
          return store.hosts.includes(new URL(url).hostname);
        } catch (_e) {
          return false;
        }
      },
      // Runs the parser, pausing for the user on sign-in or bot checks.
      async readPage(args, url, fnName = 'run') {
        const fnArgs = { storeId: store.id, range, today, ...args };
        for (;;) {
          if (isStopped()) return null;
          const result = await callInTab(tabId, fnName, fnArgs);
          if (!['login', 'challenge', 'verify', 'offhost'].includes(result.status)) return result;
          if ((await hooks.onBlocked(result.status)) !== 'continue') return null;
          if (result.status === 'challenge' || result.status === 'verify') fnArgs.ignoreChallenge = true;
          if (url) await navigate(tabId, url);
        }
      },
    };
  }

  // Reads a store's order lists for one date range. `complete` is true only if the
  // whole range was read, which is what lets a later sync skip it.
  // hooks.onOrders, if given, receives each page's orders as they're read.
  OHE.crawlList = async function crawlList(store, tabId, options, hooks) {
    const { range, today, isStopped } = options;
    const { readPage, allowedHost } = session(store, tabId, options, hooks);
    const orders = new Map();
    const stats = { pages: 0 };
    let skipped = false;
    let unreadable = false;
    const report = () => hooks.onProgress({ phase: 'list', ...stats, orders: orders.size });

    async function addOrders(found) {
      for (const order of found) {
        const key = order.orderId;
        orders.set(key, orders.has(key) ? OHE.mergeOrder(orders.get(key), order) : order);
      }
      if (hooks.onOrders && found.length) await hooks.onOrders(found);
    }

    // Returns true if the store's JSON endpoint handled the listing.
    async function crawlApi() {
      await navigate(tabId, store.ordersUrl);
      for (const term of store.listApi.terms(range, today)) {
        for (let page = 1; page <= MAX_PAGES && !isStopped(); page++) {
          const result = await readPage({ term, page }, store.ordersUrl, 'runApi');
          if (!result) {
            skipped = true;
            return true;
          }
          if (result.status !== 'ok') return false;
          stats.pages++;
          await addOrders(result.orders);
          report();
          if (!result.more) break;
          await politeDelay();
        }
      }
      return true;
    }

    // For stores whose date filter is a control on the page rather than a URL.
    // A null view means the page as it first loads.
    async function listViews() {
      await navigate(tabId, store.ordersUrl);
      const found = await readPage({}, store.ordersUrl, 'listViews');
      if (!found) {
        skipped = true;
        return [];
      }
      return found.status === 'ok' ? found.views : [null];
    }

    report();
    const apiWorked = store.listApi ? await crawlApi() : false;
    const views = store.views && !skipped && !apiWorked ? await listViews() : null;
    const queue = apiWorked ? [] : views ? views.map((view) => ({ view })) : [...store.startUrls(range, today)];
    const visited = new Set();

    while (queue.length && !isStopped() && !skipped) {
      const entry = queue.shift();
      let url = typeof entry === 'string' ? entry : store.ordersUrl;
      const key = typeof entry === 'string' ? entry : `view:${entry.view}`;
      if (visited.has(key)) continue;
      visited.add(key);
      await navigate(tabId, url);
      if (entry.view !== null && entry.view !== undefined) {
        const applied = await readPage({ view: entry.view }, url, 'applyView');
        if (!applied) {
          skipped = true;
          break;
        }
        if (applied.status !== 'ok') {
          unreadable = true;
          continue;
        }
      }
      let notFingerprint;

      while (!isStopped() && stats.pages < MAX_PAGES) {
        const page = await readPage({ mode: 'list', notFingerprint }, url);
        if (!page) {
          skipped = true;
          break;
        }
        if (page.status === 'stale') break; // the Next button did not change the list
        if (page.status === 'unparsed') {
          unreadable = true;
          hooks.onUnparsed(await callInTab(tabId, 'snapshot', {}).catch(() => null));
          break;
        }

        stats.pages++;
        await addOrders(page.orders);
        for (const extra of page.enqueue) {
          if (allowedHost(extra) && !visited.has(extra)) queue.push(extra);
        }
        report();

        // Stores list newest first, so a page entirely before the range ends this listing.
        const dates = page.orders.map((o) => o.date).filter(Boolean);
        if (range.from && dates.length && dates.every((d) => d < range.from)) break;
        if (!page.next) break;

        await politeDelay();
        if (page.next.url) {
          if (!allowedHost(page.next.url) || visited.has(page.next.url)) break;
          url = page.next.url;
          visited.add(url);
          notFingerprint = undefined;
          await navigate(tabId, url);
        } else {
          url = null;
          notFingerprint = page.fingerprint;
          await callInTab(tabId, 'clickNext', { storeId: store.id });
        }
      }
      if (queue.length) await politeDelay();
    }

    const complete = !skipped && !unreadable && !isStopped() && stats.pages < MAX_PAGES;
    return { orders: [...orders.values()], stats, skipped, complete };
  };

  // Reads each order's own page for item prices, tax, shipping, payment and address.
  // hooks.onDetail receives (order, patch), with a null patch if the page couldn't be read.
  OHE.crawlDetails = async function crawlDetails(store, tabId, wanted, options, hooks) {
    const { isStopped } = options;
    const { readPage, allowedHost } = session(store, tabId, options, hooks);
    const stats = { details: 0, detailsMissed: 0, total: wanted.length };
    if (!store.extractDetail) return stats;
    for (const order of wanted) {
      if (isStopped()) break;
      if (!allowedHost(order.detailUrl)) continue;
      await politeDelay();
      await navigate(tabId, order.detailUrl);
      const result = await readPage({ mode: 'detail', order }, order.detailUrl);
      if (!result) break;
      if (result.status === 'ok') {
        stats.details++;
        await hooks.onDetail(order, result.patch);
      } else {
        stats.detailsMissed++;
        await hooks.onDetail(order, null);
      }
      hooks.onProgress({ phase: 'details', ...stats });
    }
    return stats;
  };

  // A single complete read of one range, for exporting straight to CSV.
  OHE.crawlStore = async function crawlStore(store, tabId, options, hooks) {
    const { range, details } = options;
    const orders = new Map();
    const stats = { pages: 0, details: 0, detailsMissed: 0 };
    const report = (phase) => hooks.onProgress({ phase, ...stats, orders: orders.size });
    const listHooks = {
      ...hooks,
      onProgress: (p) => {
        stats.pages = p.pages;
        hooks.onProgress({ ...p, details: 0, detailsMissed: 0 });
      },
    };
    const list = await OHE.crawlList(store, tabId, options, listHooks);
    for (const order of list.orders) orders.set(order.orderId, order);

    if (details && !list.skipped) {
      const wanted = list.orders.filter((o) => o.detailUrl && OHE.inRange(o.date, range));
      const result = await OHE.crawlDetails(store, tabId, wanted, options, {
        ...hooks,
        onProgress: (p) => {
          stats.details = p.details;
          stats.detailsMissed = p.detailsMissed;
          report('details');
        },
        onDetail: (order, patch) => {
          if (patch) orders.set(order.orderId, OHE.mergeOrder(orders.get(order.orderId), patch));
        },
      });
      stats.details = result.details;
      stats.detailsMissed = result.detailsMissed;
    }

    report('done');
    return { orders: [...orders.values()], stats, skipped: list.skipped };
  };
})(globalThis);

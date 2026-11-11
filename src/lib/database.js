// Runs in the exporter page. Talks to the database server, and syncs one store.
(function (root) {
  const OHE = root.OHE;

  OHE.databaseClient = function databaseClient({ url, token }) {
    const base = url.replace(/\/+$/, '');

    async function call(path, options = {}) {
      let response;
      try {
        response = await fetch(`${base}${path}`, {
          ...options,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
      } catch (_e) {
        throw new Error(`Couldn't reach the database server at ${base}. Is it running?`);
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `The database server replied with an error (${response.status}).`);
      return body;
    }
    const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

    return {
      base,
      health: () => call('/api/health'),
      plan(store, range, full) {
        const query = new URLSearchParams({ store, from: range.from || '', to: range.to || '', full: full ? '1' : '0' });
        return call(`/api/sync/plan?${query}`);
      },
      saveOrders: (store, orders) => post('/api/orders', { store, orders }),
      addCoverage: (store, ranges) => post('/api/sync/coverage', { store, ranges }),
      recordRun: (store, run) => post('/api/sync/runs', { store, ...run }),
    };
  };

  // Which of the orders just read from a list need their details page opened: new
  // ones, ones whose status or total changed, and ones never read successfully.
  OHE.ordersNeedingDetails = function ordersNeedingDetails(listed, known, pending, range) {
    const wanted = new Map();
    for (const order of listed) {
      if (!order.detailUrl || !OHE.inRange(order.date, range)) continue;
      const record = known[order.orderId];
      const changed = record && record.fingerprint !== OHE.listFingerprint(order);
      if (!record || !record.detailDone || changed) wanted.set(order.orderId, order);
    }
    for (const order of pending) {
      if (!wanted.has(order.orderId)) wanted.set(order.orderId, order);
    }
    return [...wanted.values()];
  };

  // Brings one store up to date: reads only what the database says is missing,
  // saving as it goes so stopping early loses nothing.
  OHE.syncStore = async function syncStore(store, tabId, client, options, hooks) {
    const { range, full, details, today, isStopped } = options;
    const plan = await client.plan(store.id, range, full);
    const totals = { newOrders: 0, updatedOrders: 0, detailsRead: 0, detailsMissed: 0, pages: 0, gaps: plan.gaps.length };
    const listed = new Map();
    const finished = [];
    let skipped = false;

    const save = async (orders) => {
      const counts = await client.saveOrders(store.id, orders);
      totals.newOrders += counts.inserted;
      totals.updatedOrders += counts.updated;
    };

    for (const gap of plan.gaps) {
      if (isStopped()) break;
      const pagesBefore = totals.pages;
      const result = await OHE.crawlList(store, tabId, { range: gap, today, isStopped }, {
        ...hooks,
        onProgress: (p) => {
          totals.pages = pagesBefore + p.pages;
          hooks.onProgress({ phase: 'list', ...totals });
        },
        onOrders: (found) =>
          save(found.map((order) => ({ ...order, storeName: store.name, fromList: true }))),
      });
      for (const order of result.orders) listed.set(order.orderId, order);
      if (result.complete) finished.push(gap);
      if (result.skipped) {
        skipped = true;
        break;
      }
    }
    if (finished.length) await client.addCoverage(store.id, finished);

    if (details && !skipped && !isStopped()) {
      const wanted = OHE.ordersNeedingDetails([...listed.values()], plan.known, plan.pendingDetails, range);
      await OHE.crawlDetails(store, tabId, wanted, { range, today, isStopped }, {
        ...hooks,
        onProgress: (p) => {
          totals.detailsRead = p.details;
          totals.detailsMissed = p.detailsMissed;
          totals.detailsTotal = p.total;
          hooks.onProgress({ phase: 'details', ...totals });
        },
        onDetail: (order, patch) =>
          save([patch ? { ...patch, orderId: order.orderId, detailRead: true } : { orderId: order.orderId, detailFailed: true }]),
      });
    }

    const complete = finished.length === plan.gaps.length && !skipped && !isStopped();
    await client.recordRun(store.id, {
      from: range.from,
      to: range.to,
      newOrders: totals.newOrders,
      updatedOrders: totals.updatedOrders,
      detailsRead: totals.detailsRead,
      detailsMissed: totals.detailsMissed,
      complete,
    });
    hooks.onProgress({ phase: 'done', ...totals });
    return { ...totals, skipped, complete };
  };
})(globalThis);

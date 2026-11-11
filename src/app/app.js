(async function () {
  const OHE = globalThis.OHE;
  const $ = (id) => document.getElementById(id);
  const PREVIEW_LIMIT = 200;
  const SETTINGS_KEY = 'settings';

  // Store adapters are listed once, in stores/index.js, and loaded from there.
  await Promise.all(
    OHE.STORE_FILES.map(
      (file) =>
        new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = chrome.runtime.getURL(file);
          script.async = false;
          script.onload = resolve;
          script.onerror = () => reject(new Error(`Could not load ${file}`));
          document.head.append(script);
        })
    )
  );

  let run = null; // state of the current export
  let collected = []; // orders in the chosen date range
  let lastChoice = null;

  /* ---------- Setup form ---------- */

  const stores = Object.values(OHE.stores);
  for (const store of stores) {
    const label = document.createElement('label');
    label.className = 'check';
    label.style.marginTop = '0';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'store';
    box.value = store.id;
    box.checked = true;
    const span = document.createElement('span');
    span.textContent = store.name;
    label.append(box, span);
    $('stores').append(label);
  }

  const thisYear = new Date().getFullYear();
  for (let year = thisYear; year >= 2000; year--) {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = String(year);
    $('year').append(option);
  }

  function syncDateFields() {
    const preset = $('preset').value;
    $('year-field').hidden = preset !== 'year';
    $('from-field').hidden = preset !== 'custom';
    $('to-field').hidden = preset !== 'custom';
  }
  $('preset').addEventListener('change', syncDateFields);

  const checkedStores = () => [...document.querySelectorAll('input[name="store"]:checked')].map((b) => b.value);

  function readChoice() {
    return {
      storeIds: checkedStores(),
      preset: $('preset').value,
      year: $('year').value,
      from: $('from').value,
      to: $('to').value,
      layout: $('layout').value,
      split: $('split').value,
      details: $('details').checked,
      destination: $('destination').value,
      full: $('full').checked,
    };
  }

  /* ---------- Database connection ---------- */

  const DATABASE_KEY = 'database';
  const DEFAULT_SERVER = 'http://127.0.0.1:8787';

  const databaseSettings = () => ({ url: $('db-url').value.trim() || DEFAULT_SERVER, token: $('db-token').value.trim() });

  function syncDestinationFields() {
    const toDatabase = $('destination').value === 'database';
    $('database-fields').hidden = !toDatabase;
    $('csv-fields').hidden = toDatabase;
  }
  $('destination').addEventListener('change', syncDestinationFields);

  // Local servers are allowed by the manifest. Any other address needs the user's
  // permission for that one site, which Chrome only asks for right after a click.
  function serverOrigin(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('The server address must start with http:// or https://.');
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  $('db-test').addEventListener('click', async () => {
    const settings = databaseSettings();
    $('db-result').textContent = 'Checking…';
    try {
      const origins = [serverOrigin(settings.url)];
      if (!(await chrome.permissions.contains({ origins })) && !(await chrome.permissions.request({ origins }))) {
        throw new Error('Chrome needs your permission to reach that address.');
      }
      await OHE.databaseClient(settings).health();
      await chrome.storage.local.set({ [DATABASE_KEY]: settings });
      $('db-result').textContent = 'Connected.';
    } catch (err) {
      $('db-result').textContent = err.message;
    }
  });

  async function restoreSettings() {
    try {
      const stored = await chrome.storage.local.get([SETTINGS_KEY, DATABASE_KEY]);
      const saved = stored[SETTINGS_KEY];
      if (stored[DATABASE_KEY]) {
        $('db-url').value = stored[DATABASE_KEY].url || '';
        $('db-token').value = stored[DATABASE_KEY].token || '';
      }
      if (saved) {
        document.querySelectorAll('input[name="store"]').forEach((box) => {
          box.checked = saved.storeIds.includes(box.value);
        });
        for (const key of ['preset', 'year', 'from', 'to', 'layout', 'split', 'destination']) {
          if (saved[key] !== undefined) $(key).value = saved[key];
        }
        $('details').checked = saved.details;
      }
    } catch (_e) {
      // Defaults are fine if settings can't be read.
    }
    syncDateFields();
    syncDestinationFields();
  }

  function validate(choice) {
    if (!choice.storeIds.length) return 'Pick at least one store.';
    if (choice.preset === 'custom') {
      if (!choice.from && !choice.to) return 'Enter a start date, an end date, or both.';
      if (choice.from && choice.to && choice.from > choice.to) return 'The start date is after the end date.';
    }
    if (choice.destination === 'database' && !databaseSettings().token) {
      return 'Enter the access token shown when the database server starts, or choose CSV file only.';
    }
    return null;
  }

  /* ---------- Blocked pages ---------- */

  const BLOCK_MESSAGES = {
    login: (name) => `${name} needs you to sign in. Sign in using the export window, then press Continue.`,
    challenge: (name) => `${name} is asking for a security check. Complete it in the export window, then press Continue.`,
    verify: (name) => `${name} wants to confirm it's you with a code by text or email. Enter the code in the export window. When your orders are showing there, press Continue.`,
    offhost: (name) => `The extension can't read the page ${name} is showing. If it's a sign-in page, finish there in the export window and press Continue. If your orders are showing normally, press Skip this store and tell the project about it, since the store may have moved to a new web address.`,
  };

  let answerBlocked = null;

  function askUser(store, status) {
    $('blocked-text').textContent = BLOCK_MESSAGES[status](store.name);
    $('blocked').hidden = false;
    chrome.windows.update(run.windowId, { focused: true }).catch(() => {});
    return new Promise((resolve) => {
      answerBlocked = (answer) => {
        answerBlocked = null;
        $('blocked').hidden = true;
        resolve(answer);
      };
    });
  }
  $('blocked-continue').addEventListener('click', () => answerBlocked && answerBlocked('continue'));
  $('blocked-skip').addEventListener('click', () => answerBlocked && answerBlocked('skip'));

  /* ---------- Progress ---------- */

  function progressRow(store) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'store-name';
    name.textContent = store.name;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = ' waiting';
    const warning = document.createElement('div');
    warning.className = 'warning';
    warning.hidden = true;
    li.append(name, detail, warning);
    $('progress-list').append(li);
    return { detail, warning };
  }

  function describeProgress(p) {
    const orders = `${p.orders} order${p.orders === 1 ? '' : 's'}`;
    if (p.phase === 'details') return ` reading order details: ${p.details + p.detailsMissed} done of ${orders}`;
    if (p.phase === 'done') return ` finished: ${orders} read, before date filtering`;
    return ` reading order lists: ${orders} so far`;
  }

  function describeSync(p) {
    const changes = `${p.newOrders} new, ${p.updatedOrders} updated`;
    if (p.phase === 'details') return ` reading order details: ${p.detailsRead + p.detailsMissed} of ${p.detailsTotal} (${changes})`;
    if (p.phase === 'done') {
      const nothing = !p.newOrders && !p.updatedOrders && !p.detailsRead;
      return nothing ? ' already up to date' : ` finished: ${changes}, ${p.detailsRead} order details read`;
    }
    return ` reading order lists: ${changes}`;
  }

  function saveFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function showParseWarning(row, store, snapshot) {
    row.warning.hidden = false;
    row.warning.textContent = `Couldn't read a ${store.name} order page. The site may have changed. `;
    if (!snapshot) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.textContent = 'Save a redacted copy of the page for a bug report';
    button.addEventListener('click', () => saveFile(snapshot, `${store.id}-diagnostic.html`, 'text/html'));
    row.warning.append(button);
  }

  /* ---------- Running an export ---------- */

  async function startExport(choice) {
    const today = OHE.localToday();
    const range = OHE.rangeFor(choice, today);
    lastChoice = { ...choice, range };
    collected = [];
    $('results').hidden = true;
    $('progress').hidden = false;
    $('progress-list').replaceChildren();
    $('start').disabled = true;
    $('stop').hidden = false;
    $('stop').disabled = false;

    const chosen = choice.storeIds.map((id) => OHE.stores[id]);
    const rows = new Map(chosen.map((store) => [store.id, progressRow(store)]));
    const failures = [];
    let undated = 0;
    const toDatabase = choice.destination === 'database';
    const client = toDatabase ? OHE.databaseClient(databaseSettings()) : null;
    if (client) await client.health(); // fail now, before any store pages open
    const synced = { newOrders: 0, updatedOrders: 0, detailsRead: 0, detailsMissed: 0, incomplete: [] };

    // A separate real window, so pages render normally and you can sign in if asked.
    const win = await chrome.windows.create({ url: 'about:blank', width: 1100, height: 800, focused: false });
    run = { windowId: win.id, stopped: false };
    const tabId = win.tabs[0].id;
    const windowClosed = (id) => {
      if (id !== win.id) return;
      run.stopped = true;
      if (answerBlocked) answerBlocked('skip');
    };
    chrome.windows.onRemoved.addListener(windowClosed);

    for (const store of chosen) {
      if (run.stopped) break;
      const row = rows.get(store.id);
      try {
        if (client) {
          const result = await OHE.syncStore(
            store,
            tabId,
            client,
            { range, full: choice.full, details: choice.details, today, isStopped: () => run.stopped },
            {
              onProgress: (p) => {
                row.detail.textContent = describeSync(p);
              },
              onBlocked: (status) => askUser(store, status),
              onUnparsed: (snapshot) => showParseWarning(row, store, snapshot),
            }
          );
          for (const key of ['newOrders', 'updatedOrders', 'detailsRead', 'detailsMissed']) synced[key] += result[key];
          if (!result.complete) synced.incomplete.push(store.name);
          if (result.skipped) row.detail.textContent = ' skipped; anything read so far is saved';
          if (result.detailsMissed) {
            row.warning.hidden = false;
            row.warning.textContent = `Couldn't read details for ${result.detailsMissed} order(s). The next run will try them again.`;
          }
          continue;
        }
        const result = await OHE.crawlStore(
          store,
          tabId,
          { range, details: choice.details, today, isStopped: () => run.stopped },
          {
            onProgress: (p) => {
              row.detail.textContent = describeProgress(p);
            },
            onBlocked: (status) => askUser(store, status),
            onUnparsed: (snapshot) => showParseWarning(row, store, snapshot),
          }
        );
        for (const order of result.orders) {
          if (!order.date && (range.from || range.to)) undated++;
          if (OHE.inRange(order.date, range)) collected.push({ ...order, storeName: store.name });
        }
        if (result.skipped) row.detail.textContent = ' skipped';
        if (result.stats.detailsMissed) {
          row.warning.hidden = false;
          row.warning.textContent = `Couldn't read details for ${result.stats.detailsMissed} order(s); their list information was kept.`;
        }
      } catch (err) {
        failures.push(store.name);
        row.warning.hidden = false;
        row.warning.textContent = `Stopped with an error: ${err.message}`;
      }
    }

    chrome.windows.onRemoved.removeListener(windowClosed);
    await chrome.windows.remove(win.id).catch(() => {});
    const stopped = run.stopped;
    run = null;
    $('start').disabled = false;
    $('stop').hidden = true;
    if (client) showSyncResults({ client, synced, stopped, failures });
    else showResults({ stopped, undated, failures });
  }

  function showSyncResults({ client, synced, stopped, failures }) {
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    $('results').hidden = false;
    $('results-title').textContent = `${count(synced.newOrders, 'new order')}, ${synced.updatedOrders} updated`;
    const notes = [`${count(synced.detailsRead, 'order detail')} read.`];
    if (stopped) notes.push('The run was stopped early. What it read is saved, and the next run picks up the rest.');
    if (failures.length) notes.push(`${failures.join(', ')} ended with an error. The next run will try again.`);
    else if (synced.incomplete.length && !stopped) notes.push(`${synced.incomplete.join(', ')} didn't finish, so the next run will read the rest.`);
    $('results-note').textContent = notes.join(' ');
    $('download').hidden = true;
    $('preview-wrap').hidden = true;
    $('preview-note').textContent = '';
    $('open-reports').hidden = false;
    // The web app has its own sign-in; the token is only for syncing.
    $('open-reports').href = `${client.base}/`;
  }

  function showResults({ stopped, undated, failures }) {
    $('download').hidden = false;
    $('preview-wrap').hidden = false;
    $('open-reports').hidden = true;
    const count = collected.length;
    const itemCount = collected.reduce((sum, o) => sum + o.items.length, 0);
    $('results').hidden = false;
    $('results-title').textContent = `${count} order${count === 1 ? '' : 's'}, ${itemCount} item${itemCount === 1 ? '' : 's'}`;
    const notes = [];
    if (stopped) notes.push('The export was stopped early, so this list is partial.');
    if (failures.length) notes.push(`${failures.join(', ')} ended with an error, so this list may be partial.`);
    if (undated) notes.push(`${undated} order(s) had no readable date and were left out.`);
    $('results-note').textContent = notes.join(' ');
    $('download').disabled = count === 0;

    const sorted = OHE.sortOrders(collected);
    $('preview').replaceChildren(
      ...sorted.slice(0, PREVIEW_LIMIT).map((order) => {
        const tr = document.createElement('tr');
        const total = typeof order.total === 'number' ? order.total.toFixed(2) : '';
        const cells = [order.date || '', order.storeName, order.orderId, order.items.map((i) => i.name).join('; '), order.payment || '', total];
        cells.forEach((value, i) => {
          const td = document.createElement('td');
          td.textContent = value;
          if (i === 5) td.className = 'num';
          tr.append(td);
        });
        return tr;
      })
    );
    $('preview-note').textContent =
      sorted.length > PREVIEW_LIMIT ? `Showing the newest ${PREVIEW_LIMIT}. The CSV has all ${sorted.length}.` : '';
  }

  function fileLabel(range) {
    if (!range.from && !range.to) return 'all-time';
    return `${range.from || 'start'}_to_${range.to || OHE.localToday()}`;
  }

  $('download').addEventListener('click', () => {
    const { layout, split, range } = lastChoice;
    const label = fileLabel(range);
    if (split === 'per-store') {
      const ids = [...new Set(collected.map((o) => o.store))];
      for (const id of ids) {
        const csv = OHE.toCsv(collected.filter((o) => o.store === id), layout);
        saveFile(csv, `orders_${id}_${label}.csv`, 'text/csv;charset=utf-8');
      }
    } else {
      saveFile(OHE.toCsv(collected, layout), `orders_${label}.csv`, 'text/csv;charset=utf-8');
    }
  });

  $('stop').addEventListener('click', () => {
    if (!run) return;
    run.stopped = true;
    $('stop').disabled = true;
    if (answerBlocked) answerBlocked('skip');
  });

  // Store files load from disk straight away, but Chrome only grants a new site's
  // permission when the extension is reloaded, so a store can be listed yet unreadable.
  async function storesMissingAccess(storeIds) {
    const missing = [];
    for (const id of storeIds) {
      const store = OHE.stores[id];
      const origins = store.hosts.map((host) => `https://${host}/*`);
      if (!(await chrome.permissions.contains({ origins }))) missing.push(store.name);
    }
    return missing;
  }

  $('setup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const choice = readChoice();
    let problem = validate(choice);
    if (!problem) {
      const missing = await storesMissingAccess(choice.storeIds);
      if (missing.length) {
        problem = `Chrome hasn't given this extension access to ${missing.join(' and ')}. Go to chrome://extensions, click the reload arrow on Order History Exporter, then reopen this page.`;
      } else if (choice.destination === 'database') {
        try {
          const origins = [serverOrigin(databaseSettings().url)];
          if (!(await chrome.permissions.contains({ origins }))) {
            problem = 'This extension needs permission to reach the database server. Press Test connection. If this is the local server, reload the extension at chrome://extensions first.';
          }
        } catch (err) {
          problem = err.message;
        }
      }
    }
    $('form-error').hidden = !problem;
    $('form-error').textContent = problem || '';
    if (problem) return;
    // "Re-read everything" is deliberately not remembered, so it can't stay on by accident.
    chrome.storage.local.set({ [SETTINGS_KEY]: { ...choice, full: false }, [DATABASE_KEY]: databaseSettings() }).catch(() => {});
    startExport(choice).catch((err) => {
      $('start').disabled = false;
      $('stop').hidden = true;
      $('form-error').hidden = false;
      $('form-error').textContent = `The export couldn't start: ${err.message}`;
    });
  });

  window.addEventListener('beforeunload', (event) => {
    if (run) event.preventDefault();
  });

  syncDateFields();
  syncDestinationFields();
  await restoreSettings();
})();

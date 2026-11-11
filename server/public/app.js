(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'order-reports-token';
  const PAGE_SIZE = 50;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const wholeMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const whole = new Intl.NumberFormat('en-US');
  const formatMoney = (n) => (typeof n === 'number' ? money.format(n) : '–');

  let token = null;
  let offset = 0;
  let itemsOffset = 0;
  let loadId = 0;
  let activeView = 'overview';
  let meta = { categories: [], forms: {} };
  let statusData = { stores: [], payments: [], zips: [], years: [] };
  const orderSort = { sort: 'date', dir: 'desc' };
  const itemSort = { sort: 'date', dir: 'desc' };
  const STATUS_LABELS = { unreviewed: 'Not reviewed', business: 'Business', personal: 'Personal' };
  const SOURCE_NOTES = { rule: 'guessed from the name', learned: 'learned from your changes', store: 'guessed from the store', none: '', you: '' };

  function readStored() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch (_e) {
      return null;
    }
  }
  function store(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_e) {
      // Without storage the token is simply asked for again next time.
    }
  }

  class AuthError extends Error {}

  async function api(path) {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) throw new AuthError('That access token was not accepted.');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `The server replied with an error (${response.status}).`);
    }
    return response;
  }
  const getJson = async (path) => (await api(path)).json();
  async function postJson(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 401) throw new AuthError('That access token was not accepted.');
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `The server replied with an error (${response.status}).`);
    return result;
  }

  /* ---------- Filters ---------- */

  function isoDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function dateRange() {
    const year = new Date().getFullYear();
    switch ($('preset').value) {
      case 'this-year':
        return { from: `${year}-01-01`, to: '' };
      case 'last-year':
        return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
      case 'last-90':
        return { from: isoDaysAgo(90), to: '' };
      case 'custom':
        return { from: $('from').value, to: $('to').value };
      default:
        return { from: '', to: '' };
    }
  }

  function filterQuery(extra = {}) {
    const params = new URLSearchParams();
    const values = {
      ...dateRange(),
      store: $('store').value,
      payment: $('payment').value,
      zip: $('zip').value,
      category: $('category').value,
      q: $('q').value.trim(),
      ...extra,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value !== '' && value !== null && value !== undefined) params.set(key, value);
    }
    return params.toString();
  }

  /* ---------- Drawing helpers ---------- */

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  // Column headings that sort when clicked. columns: [key or null, label, class].
  function sortableHead(thead, columns, state, reload) {
    const row = el('tr');
    for (const [key, label, className] of columns) {
      const th = el('th', key ? null : label, className);
      if (key) {
        const button = el('button', label, 'sort');
        button.type = 'button';
        button.addEventListener('click', () => {
          if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else Object.assign(state, { sort: key, dir: key === 'date' || key === 'total' || key === 'amount' ? 'desc' : 'asc' });
          reload();
        });
        th.append(button);
        if (state.sort === key) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      }
      row.append(th);
    }
    thead.replaceChildren(row);
  }

  function fillSelect(select, firstLabel, options) {
    const current = select.value;
    const first = firstLabel === null ? [] : [new Option(firstLabel, '')];
    select.replaceChildren(...first, ...options.map(([value, label]) => new Option(label, value)));
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }

  function emptyRow(body, columns, text) {
    const td = el('td', text, 'muted');
    td.colSpan = columns;
    const tr = el('tr');
    tr.append(td);
    body.replaceChildren(tr);
  }

  function niceMax(value) {
    if (value <= 0) return 100;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) {
      if (step * magnitude >= value) return step * magnitude;
    }
    return 10 * magnitude;
  }

  function monthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    return `${MONTH_NAMES[month - 1]} ${year}`;
  }

  // Every month in the span, so a month with no orders shows as a real gap.
  function fillMonths(rows) {
    if (!rows.length) return [];
    const byKey = new Map(rows.map((row) => [row.label, row]));
    const [startYear, startMonth] = rows[0].label.split('-').map(Number);
    const [endYear, endMonth] = rows[rows.length - 1].label.split('-').map(Number);
    const months = [];
    for (let y = startYear, m = startMonth; y < endYear || (y === endYear && m <= endMonth); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      months.push(byKey.get(key) || { label: key, orders: 0, spend: 0 });
    }
    return months;
  }

  function showTooltip(event, lines) {
    const tip = $('tooltip');
    tip.replaceChildren(...lines.map((line, i) => el('div', line, i ? 'muted' : '')));
    tip.hidden = false;
    const box = tip.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top;
    tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - box.width - 8))}px`;
    tip.style.top = `${Math.max(8, y - box.height - 10)}px`;
  }

  function drawMonths(rows) {
    const holder = $('months');
    const months = fillMonths(rows);
    if (!months.length) {
      holder.replaceChildren(el('p', 'No dated orders match these filters.', 'empty'));
      return;
    }
    const margin = { top: 10, right: 8, bottom: 26, left: 58 };
    const height = 240;
    const slot = Math.max(8, Math.min(44, (holder.clientWidth - margin.left - margin.right) / months.length));
    const width = margin.left + margin.right + slot * months.length;
    const plot = height - margin.top - margin.bottom;
    const top = niceMax(Math.max(...months.map((m) => m.spend), 0));
    const low = Math.min(...months.map((m) => m.spend), 0);
    const bottom = low < 0 ? -niceMax(-low) : 0;
    const y = (value) => margin.top + plot * (1 - (value - bottom) / (top - bottom));

    const chart = svg('svg', { width, height, role: 'img', 'aria-label': 'Spending by month. The same figures are in the CSV downloads.' });
    const ticks = bottom < 0 ? [bottom, 0, top] : [0, top / 4, top / 2, (top * 3) / 4, top];
    for (const value of ticks) {
      chart.append(svg('line', { class: 'gridline', x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value) }));
      const label = svg('text', { x: margin.left - 8, y: y(value) + 4, 'text-anchor': 'end' });
      label.textContent = wholeMoney.format(value);
      chart.append(label);
    }

    const barWidth = Math.min(24, Math.max(4, slot - 2));
    const labelEvery = Math.ceil(52 / slot);
    months.forEach((month, index) => {
      const x = margin.left + index * slot;
      const column = svg('g', { class: 'column', tabindex: '0', 'aria-label': `${monthLabel(month.label)}: ${money.format(month.spend)}, ${month.orders} orders` });
      column.append(svg('rect', { class: 'hit', x, y: margin.top, width: slot, height: plot }));
      if (month.spend !== 0) {
        const up = month.spend > 0;
        const barTop = y(Math.max(month.spend, 0));
        const barHeight = Math.max(1, Math.abs(y(month.spend) - y(0)));
        const left = x + (slot - barWidth) / 2;
        const radius = Math.min(4, barHeight, barWidth / 2);
        const right = left + barWidth;
        const bottomEdge = barTop + barHeight;
        // Rounded only at the data end; square where the bar meets the baseline.
        const d = up
          ? `M${left},${bottomEdge}V${barTop + radius}Q${left},${barTop} ${left + radius},${barTop}H${right - radius}Q${right},${barTop} ${right},${barTop + radius}V${bottomEdge}Z`
          : `M${left},${barTop}V${bottomEdge - radius}Q${left},${bottomEdge} ${left + radius},${bottomEdge}H${right - radius}Q${right},${bottomEdge} ${right},${bottomEdge - radius}V${barTop}Z`;
        column.append(svg('path', { class: 'bar', d }));
      }
      if (index % labelEvery === 0) {
        const label = svg('text', { x: x + slot / 2, y: height - 8, 'text-anchor': 'middle' });
        const [year, monthNumber] = month.label.split('-').map(Number);
        label.textContent = labelEvery >= 12 ? String(year) : `${MONTH_NAMES[monthNumber - 1]} ${String(year).slice(2)}`;
        column.append(label);
      }
      const show = (event) =>
        showTooltip(event, [monthLabel(month.label), money.format(month.spend), `${month.orders} order${month.orders === 1 ? '' : 's'}`]);
      column.addEventListener('mousemove', show);
      column.addEventListener('focus', show);
      column.addEventListener('mouseleave', () => {
        $('tooltip').hidden = true;
      });
      column.addEventListener('blur', () => {
        $('tooltip').hidden = true;
      });
      chart.append(column);
    });
    holder.replaceChildren(chart);
  }

  function drawRank(holder, rows, emptyText) {
    if (!rows.length) {
      holder.replaceChildren(el('p', emptyText, 'empty'));
      return;
    }
    const max = Math.max(...rows.map((row) => Math.abs(row.spend)), 1);
    const grid = el('div', null, 'rank');
    for (const row of rows) {
      const track = el('div', null, 'rank-track');
      const bar = el('div', null, 'rank-bar');
      bar.style.width = `${Math.max(0, (Math.abs(row.spend) / max) * 100)}%`;
      track.append(bar);
      const value = el('div', null, 'rank-value');
      value.append(`${money.format(row.spend)} `, el('span', `· ${row.orders} order${row.orders === 1 ? '' : 's'}`));
      grid.append(el('div', row.label, 'rank-label'), track, value);
    }
    holder.replaceChildren(grid);
  }

  /* ---------- Sections ---------- */

  function showReport(report) {
    const { totals } = report;
    $('t-spend').textContent = formatMoney(totals.spend ?? 0);
    $('t-orders').textContent = whole.format(totals.orders);
    $('t-average').textContent = formatMoney(totals.average);
    $('t-tax').textContent = totals.tax === null ? '–' : formatMoney(totals.tax ?? 0);

    const caveats = [];
    if ($('category').value) caveats.push("Amounts show this category's share of each order.");
    if (totals.estimatedItems) caveats.push(`${totals.estimatedItems} item(s) have no price yet, so their share of the order is estimated.`);
    if (totals.withoutTotal) caveats.push(`${totals.withoutTotal} order(s) have no total yet, so they aren't in the money figures.`);
    if (totals.withoutDetails) caveats.push(`${totals.withoutDetails} order(s) have no details yet, so tax may be understated.`);
    if (totals.undated) caveats.push(`${totals.undated} order(s) have no date and only appear when no period is set.`);
    $('caveats').textContent = caveats.join(' ');

    drawMonths(report.byMonth);
    drawRank($('by-category'), report.byCategory, 'No items match these filters.');
    drawRank($('by-store'), report.byStore, 'No orders match these filters.');
    drawRank($('by-payment'), report.byPayment, 'No orders match these filters.');
    drawRank($('by-zip'), report.byZip, 'No delivery addresses match these filters.');

    if (report.topItems.length) {
      $('top-items').replaceChildren(
        ...report.topItems.map((item) => {
          const tr = el('tr');
          tr.append(
            el('td', item.label),
            el('td', whole.format(item.orders), 'num'),
            el('td', whole.format(item.quantity), 'num'),
            el('td', item.lastBought || '', 'nowrap')
          );
          return tr;
        })
      );
    } else {
      emptyRow($('top-items'), 4, 'No items match these filters.');
    }
  }

  function safeLink(url, text) {
    if (!/^https:\/\//i.test(url || '')) return el('span', text);
    const link = el('a', text);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function showOrders({ total, orders }) {
    $('orders-title').textContent = `Orders (${whole.format(total)})`;
    sortableHead(
      $('orders-head'),
      [['date', 'Date'], ['store', 'Store'], [null, 'Order'], [null, 'Items'], ['zip', 'Delivery ZIP'], ['payment', 'Payment'], ['total', 'Total', 'num']],
      orderSort,
      () => {
        offset = 0;
        loadData();
      }
    );
    if (orders.length) {
      $('orders').replaceChildren(
        ...orders.map((order) => {
          const tr = el('tr');
          const id = el('td', null, 'nowrap');
          id.append(safeLink(order.url, order.orderId));
          tr.append(
            el('td', order.date || '', 'nowrap'),
            el('td', order.storeName || order.store, 'nowrap'),
            id,
            el('td', order.items.map((item) => item.name).join('; ')),
            el('td', order.deliveryZip || '', 'nowrap'),
            el('td', order.payment || '', 'nowrap'),
            el('td', formatMoney(order.total), 'num')
          );
          return tr;
        })
      );
    } else {
      emptyRow($('orders'), 7, 'No orders match these filters.');
    }
    $('prev').disabled = offset === 0;
    $('next').disabled = offset + PAGE_SIZE >= total;
    $('page-note').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${whole.format(total)}` : '';
    $('csv-items').disabled = !total;
    $('csv-orders').disabled = !total;
  }

  function coverageText(coverage) {
    if (!coverage.length) return 'Not yet';
    return coverage.map((c) => `${c.from || 'Beginning'} to ${c.to}`).join('; ');
  }

  function showStatus(data) {
    statusData = data;
    const { stores, payments, zips, years } = data;
    fillSelect($('store'), 'All stores', stores.map((s) => [s.store, s.name]));
    fillSelect($('payment'), 'All payment methods', payments.map((p) => [p, p]));
    fillSelect($('zip'), 'All ZIPs', [...zips.map((z) => [z, z]), ['none', 'No delivery ZIP']]);
    fillSelect($('tax-zip'), 'All ZIPs', zips.map((z) => [z, z]));
    fillSelect($('tax-year'), 'All years', years.map((y) => [y, y]));
    if (!$('tax-year').dataset.chosen && years.length) $('tax-year').value = years.includes(String(new Date().getFullYear() - 1)) ? String(new Date().getFullYear() - 1) : years[0];
    fillRuleValues();

    if (stores.length) {
      $('sync').replaceChildren(
        ...stores.map((s) => {
          const tr = el('tr');
          const last = s.lastRun.finished_at ? new Date(s.lastRun.finished_at).toLocaleString() : 'Never';
          tr.append(
            el('td', s.name, 'nowrap'),
            el('td', whole.format(s.orders), 'num'),
            el('td', coverageText(s.coverage)),
            el('td', whole.format(s.missingDetails), 'num'),
            el('td', last, 'nowrap')
          );
          return tr;
        })
      );
      const runs = stores.map((s) => s.lastRun.finished_at).filter(Boolean).sort();
      $('freshness').textContent = runs.length ? `Last synced ${new Date(runs[runs.length - 1]).toLocaleString()}` : '';
    } else {
      emptyRow($('sync'), 5, 'Nothing synced yet. Run the Chrome extension to fill the database.');
      $('freshness').textContent = '';
    }
  }

  /* ---------- Items view ---------- */

  function categorySelect(item) {
    const select = el('select');
    select.setAttribute('aria-label', `Category for ${item.name || 'this item'}`);
    const names = meta.categories.map((c) => c.name);
    if (!names.includes(item.category)) names.push(item.category);
    select.append(...names.map((name) => new Option(name, name)));
    select.value = item.category;
    select.addEventListener('change', () =>
      act(async () => {
        await postJson('/api/items/category', { name: item.name, category: select.value });
        await loadData();
      })
    );
    return select;
  }

  function statusSelect(item) {
    const select = el('select');
    select.setAttribute('aria-label', `Business or personal for ${item.name || 'this item'}`);
    select.append(...Object.entries(STATUS_LABELS).map(([value, label]) => new Option(label, value)));
    select.value = item.status;
    select.addEventListener('change', () =>
      act(async () => {
        await postJson('/api/items/status', { status: select.value, items: [{ store: item.store, orderId: item.orderId, name: item.name }] });
        await loadData();
      })
    );
    return select;
  }

  function showItems({ total, amount, items }) {
    $('items-title').textContent = `Items (${whole.format(total)}, ${money.format(amount)})`;
    sortableHead(
      $('items-head'),
      [['date', 'Date'], ['store', 'Store'], ['item', 'Item'], ['category', 'Category'], ['zip', 'Delivery ZIP'], ['payment', 'Payment'], ['amount', 'Amount', 'num'], ['status', 'Business or personal']],
      itemSort,
      () => {
        itemsOffset = 0;
        loadData();
      }
    );
    if (items.length) {
      $('items').replaceChildren(
        ...items.map((item) => {
          const tr = el('tr');
          const name = el('td');
          name.append(item.url ? safeLink(item.url, item.name) : el('span', item.name));
          const category = el('td');
          category.append(categorySelect(item));
          if (SOURCE_NOTES[item.categorySource]) category.append(el('div', SOURCE_NOTES[item.categorySource], 'guess'));
          const amountCell = el('td', typeof item.amount === 'number' ? `${item.estimated ? '≈ ' : ''}${money.format(item.amount)}` : '–', 'num');
          if (item.estimated) amountCell.title = 'Estimated: this order has no item prices yet, so its total is split evenly.';
          const status = el('td');
          status.append(statusSelect(item));
          if (item.statusSource === 'rule') status.append(el('div', 'from a rule', 'guess'));
          tr.append(
            el('td', item.date || '', 'nowrap'),
            el('td', item.storeName, 'nowrap'),
            name,
            category,
            el('td', item.deliveryZip || '', 'nowrap'),
            el('td', item.payment || '', 'nowrap'),
            amountCell,
            status
          );
          return tr;
        })
      );
    } else {
      emptyRow($('items'), 8, 'No items match these filters.');
    }
    $('items-prev').disabled = itemsOffset === 0;
    $('items-next').disabled = itemsOffset + PAGE_SIZE >= total;
    $('items-page-note').textContent = total ? `${itemsOffset + 1}–${Math.min(itemsOffset + PAGE_SIZE, total)} of ${whole.format(total)}` : '';
    for (const id of ['csv-item-list', 'mark-business', 'mark-personal']) $(id).disabled = !total;
    $('mark-business').dataset.total = total;
  }

  function currentFilterObject() {
    return Object.fromEntries(new URLSearchParams(filterQuery({ status: $('status-filter').value })));
  }

  async function markMatching(status) {
    const count = Number($('mark-business').dataset.total) || 0;
    // Bulk changes affect records used for taxes, so they're confirmed first.
    if (!window.confirm(`Mark all ${count} matching item(s) as ${status}? You can change them back later.`)) return;
    await act(async () => {
      const { changed } = await postJson('/api/items/status', { status, filters: currentFilterObject() });
      $('mark-note').textContent = `${changed} item(s) marked ${status}.`;
      await loadData();
    });
  }

  /* ---------- Tax view ---------- */

  function fillRuleValues() {
    const field = $('rule-field').value;
    const options = {
      zip: statusData.zips.map((z) => [z, z]),
      payment: statusData.payments.map((p) => [p, p]),
      store: statusData.stores.map((s) => [s.store, s.name]),
      category: meta.categories.map((c) => [c.name, c.name]),
    }[field];
    fillSelect($('rule-value'), null, options || []);
    $('rule-form').querySelector('button').disabled = !(options && options.length);
  }

  function ruleText(rule) {
    const labels = { zip: 'Delivery ZIP is', payment: 'Payment method is', store: 'Store is', category: 'Category is' };
    const store = rule.field === 'store' && statusData.stores.find((s) => s.store === rule.value);
    return `${labels[rule.field]} ${store ? store.name : rule.value}: ${STATUS_LABELS[rule.status]}`;
  }

  function showRules(rules) {
    if (!rules.length) {
      $('rules').replaceChildren(el('li', 'No rules yet.', 'muted'));
      return;
    }
    $('rules').replaceChildren(
      ...rules.map((rule) => {
        const li = el('li');
        const remove = el('button', 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove rule: ${ruleText(rule)}`);
        remove.addEventListener('click', () =>
          act(async () => {
            await postJson('/api/tax/rules/delete', { id: rule.id });
            await loadData();
          })
        );
        li.append(el('span', ruleText(rule)), remove);
        return li;
      })
    );
  }

  function showMapping(form) {
    const key = form === 'schedule-e' ? 'scheduleE' : 'scheduleC';
    const lines = meta.forms[form].lines;
    $('mapping-head').textContent = `${meta.forms[form].name} line`;
    $('mapping').replaceChildren(
      ...meta.categories.map((category) => {
        const tr = el('tr');
        const select = el('select');
        select.setAttribute('aria-label', `Form line for ${category.name}`);
        select.append(new Option('Choose a line', ''), ...lines.map(([line, label]) => new Option(`${line}: ${label}`, line)));
        select.value = category[key] || '';
        select.addEventListener('change', () =>
          act(async () => {
            const { categories } = await postJson('/api/categories', { ...category, [key]: select.value || null });
            meta.categories = categories;
            await loadData();
          })
        );
        const cell = el('td');
        cell.append(select);
        tr.append(el('td', category.name), cell);
        return tr;
      })
    );
  }

  function taxQuery() {
    const params = new URLSearchParams({ form: $('tax-form').value });
    if ($('tax-year').value) params.set('year', $('tax-year').value);
    if ($('tax-zip').value) params.set('zip', $('tax-zip').value);
    return params.toString();
  }

  function showTax(report, rules) {
    const { totals } = report;
    $('tax-business').textContent = money.format(totals.business);
    $('tax-unreviewed').textContent = money.format(totals.unreviewed);
    $('tax-personal').textContent = money.format(totals.personal);
    $('tax-title').textContent = `${report.formName} expense lines`;

    const caveats = [];
    if (totals.unreviewedItems) caveats.push(`${totals.unreviewedItems} item(s) aren't marked business or personal yet, so they aren't counted. Use a rule below, or the Items tab.`);
    if (totals.noAmount) caveats.push(`${totals.noAmount} item(s) have no amount, because their order has no total yet.`);
    const estimated = report.lines.reduce((sum, line) => sum + line.estimated, 0);
    if (estimated) caveats.push(`${estimated} counted item(s) have estimated amounts, because their order has no item prices yet. Syncing again with Open each order fills these in.`);
    $('tax-caveats').textContent = caveats.join(' ');

    const rows = report.lines.map((line) => {
      const tr = el('tr');
      tr.append(
        el('td', line.line, 'nowrap'),
        el('td', line.label),
        el('td', money.format(line.amount), 'num'),
        el('td', whole.format(line.items), 'num'),
        el('td', line.note || '', 'muted')
      );
      return tr;
    });
    for (const entry of report.unassigned) {
      const tr = el('tr');
      tr.append(
        el('td', 'None', 'nowrap'),
        el('td', entry.category),
        el('td', money.format(entry.amount), 'num'),
        el('td', whole.format(entry.items), 'num'),
        el('td', 'Choose a form line for this category below, or mark these items personal.', 'muted')
      );
      rows.push(tr);
    }
    if (rows.length) $('tax-lines').replaceChildren(...rows);
    else emptyRow($('tax-lines'), 5, 'No business items for this year yet. Add a rule below, or mark items on the Items tab.');

    $('tax-review-panel').hidden = !report.review.length;
    $('tax-review-note').textContent = `Items of ${wholeMoney.format(report.reviewAmount)} or more may need to be depreciated rather than deducted all at once. Ask your preparer.`;
    $('tax-review').replaceChildren(
      ...report.review.map((item) => {
        const tr = el('tr');
        tr.append(el('td', item.date || '', 'nowrap'), el('td', item.name), el('td', item.category), el('td', money.format(item.amount), 'num'));
        return tr;
      })
    );

    showRules(rules);
    showMapping(report.form);
    fillRuleValues();
  }

  function showError(err) {
    if (err instanceof AuthError) {
      token = null;
      store(null);
      $('content').hidden = true;
      $('signin').hidden = false;
      $('signin-error').textContent = err.message;
      $('signin-error').hidden = false;
      return;
    }
    $('error').textContent = err.message;
    $('error').hidden = false;
  }

  // Older requests are ignored if the filters changed while they were running.
  async function loadData() {
    const id = ++loadId;
    try {
      if (activeView === 'overview') {
        const [report, orders] = await Promise.all([
          getJson(`/api/report?${filterQuery()}`),
          getJson(`/api/orders?${filterQuery({ limit: PAGE_SIZE, offset, ...orderSort })}`),
        ]);
        if (id !== loadId) return;
        showReport(report);
        showOrders(orders);
      } else if (activeView === 'items') {
        const items = await getJson(`/api/items?${filterQuery({ limit: PAGE_SIZE, offset: itemsOffset, status: $('status-filter').value, ...itemSort })}`);
        if (id !== loadId) return;
        showItems(items);
      } else {
        const [report, { rules }] = await Promise.all([getJson(`/api/tax/report?${taxQuery()}`), getJson('/api/tax/rules')]);
        if (id !== loadId) return;
        showTax(report, rules);
      }
      $('error').hidden = true;
    } catch (err) {
      if (id === loadId) showError(err);
    }
  }

  // Runs a change, showing any failure, then redraws from the server's copy on failure too.
  async function act(fn) {
    try {
      await fn();
    } catch (err) {
      showError(err);
      loadData();
    }
  }

  function showView(view) {
    activeView = view;
    for (const name of ['overview', 'items', 'tax']) {
      $(`view-${name}`).hidden = name !== view;
      $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
    }
    $('filters').hidden = view === 'tax';
    $('error').hidden = true;
    loadData();
  }

  async function start() {
    try {
      meta = await getJson('/api/categories');
      fillSelect($('category'), 'All categories', meta.categories.map((c) => [c.name, c.name]));
      showStatus(await getJson('/api/status'));
    } catch (err) {
      showError(err);
      return;
    }
    store(token);
    $('signin').hidden = true;
    $('signin-error').hidden = true;
    $('content').hidden = false;
    await loadData();
  }

  async function saveCsv(path, filename) {
    try {
      const response = await api(path);
      const url = URL.createObjectURL(await response.blob());
      const link = el('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      showError(err);
    }
  }

  function periodLabel() {
    const { from, to } = dateRange();
    return from || to ? `${from || 'start'}_to_${to || 'today'}` : 'all-time';
  }

  const downloadCsv = (layout) =>
    saveCsv(`/api/export.csv?${filterQuery({ layout, ...orderSort })}`, `orders_${periodLabel()}_${layout}.csv`);

  function downloadTaxCsv(detail) {
    const year = $('tax-year').value || 'all-years';
    saveCsv(`/api/tax/export.csv?${taxQuery()}&detail=${detail}`, `${$('tax-form').value}_${year}_${detail}.csv`);
  }

  /* ---------- Events ---------- */

  let searchTimer = null;
  function refilter() {
    offset = 0;
    itemsOffset = 0;
    $('mark-note').textContent = '';
    loadData();
  }
  for (const name of ['overview', 'items', 'tax']) $(`tab-${name}`).addEventListener('click', () => showView(name));
  $('status-filter').addEventListener('change', refilter);
  $('items-prev').addEventListener('click', () => {
    itemsOffset = Math.max(0, itemsOffset - PAGE_SIZE);
    loadData();
  });
  $('items-next').addEventListener('click', () => {
    itemsOffset += PAGE_SIZE;
    loadData();
  });
  $('csv-item-list').addEventListener('click', () =>
    saveCsv(`/api/items.csv?${filterQuery({ status: $('status-filter').value, ...itemSort })}`, `items_${periodLabel()}.csv`)
  );
  $('mark-business').addEventListener('click', () => markMatching('business'));
  $('mark-personal').addEventListener('click', () => markMatching('personal'));
  $('tax-year').addEventListener('change', () => {
    $('tax-year').dataset.chosen = '1';
    loadData();
  });
  for (const id of ['tax-form', 'tax-zip']) $(id).addEventListener('change', loadData);
  $('tax-csv-summary').addEventListener('click', () => downloadTaxCsv('summary'));
  $('tax-csv-items').addEventListener('click', () => downloadTaxCsv('items'));
  $('rule-field').addEventListener('change', fillRuleValues);
  $('rule-form').addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      await postJson('/api/tax/rules', { field: $('rule-field').value, value: $('rule-value').value, status: $('rule-status').value });
      await loadData();
    });
  });
  $('category-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('new-category').value.trim();
    if (!name) return;
    act(async () => {
      const { categories } = await postJson('/api/categories', { name, scheduleC: null, scheduleE: null });
      meta.categories = categories;
      $('new-category').value = '';
      fillSelect($('category'), 'All categories', meta.categories.map((c) => [c.name, c.name]));
      await loadData();
    });
  });
  $('preset').addEventListener('change', () => {
    const custom = $('preset').value === 'custom';
    $('from-field').hidden = !custom;
    $('to-field').hidden = !custom;
    refilter();
  });
  for (const id of ['from', 'to', 'store', 'payment', 'zip', 'category']) $(id).addEventListener('change', refilter);
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refilter, 250);
  });
  $('filters').addEventListener('submit', (event) => event.preventDefault());
  $('prev').addEventListener('click', () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    loadData();
  });
  $('next').addEventListener('click', () => {
    offset += PAGE_SIZE;
    loadData();
  });
  $('csv-items').addEventListener('click', () => downloadCsv('items'));
  $('csv-orders').addEventListener('click', () => downloadCsv('orders'));
  $('signin').addEventListener('submit', (event) => {
    event.preventDefault();
    token = $('token').value.trim();
    start();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(loadData, 200);
  });

  // A link can carry the token after the #, which browsers don't send to servers.
  // It's moved into storage and removed from the address bar straight away.
  const fragment = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fragment) history.replaceState(null, '', location.pathname);
  token = fragment || readStored();
  if (token) start();
  else $('signin').hidden = false;
})();

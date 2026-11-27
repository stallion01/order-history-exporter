// Venmo statements, fetched from venmo.com with the Venmo account this Chrome is signed
// in to, and sent to the Business Hub's My money with a person's Venmo sync key. Used by
// the exporter page (Sync now) and the background worker (once a week by itself).
//
// It reads only what venmo.com's own Statements page offers as "Download CSV": the same
// file, for a date range. It never signs in, and nothing is saved on this computer.
(function (root) {
  const OHE = (root.OHE = root.OHE || {});
  const VENMO = 'https://account.venmo.com';
  const DAY = 86400000;
  // The first sync goes back a year; later ones from a little before the newest payment
  // already imported, since late payments can appear with earlier dates.
  const FIRST_DAYS = 365;
  const OVERLAP_DAYS = 14;

  OHE.VENMO_KEY = 'venmo';
  OHE.VENMO_EVERY_DAYS = 7;

  const iso = (date) => date.toISOString().slice(0, 10);

  OHE.venmoSync = async function venmoSync({ url, key }, { now = new Date() } = {}) {
    if (!url || !key) throw new Error('Enter the Business Hub address and your Venmo sync key first.');
    const base = url.replace(/\/+$/, '');
    async function hub(path, options = {}) {
      let response;
      try {
        response = await fetch(`${base}${path}`, { ...options, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
      } catch (_e) {
        throw new Error(`Couldn't reach the Business Hub at ${base}. Is this computer connected to it?`);
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `The Business Hub replied with an error (${response.status}).`);
      return body;
    }

    const status = await hub('/api/personal/venmo');

    // Which Venmo profile is signed in, from the Statements page; a page on id.venmo.com
    // means nobody is.
    let page;
    try {
      page = await fetch(`${VENMO}/statement`, { credentials: 'include' });
    } catch (_e) {
      throw new Error("Couldn't reach venmo.com.");
    }
    if (!page.ok || !page.url.startsWith(VENMO)) throw new Error('Sign in to venmo.com in this Chrome, then sync again.');
    const html = await page.text();
    const profileId = new URL(page.url).searchParams.get('profileId') || (html.match(/"selectedProfileId"\s*:\s*"?(\d+)/) || [])[1];
    if (!profileId) throw new Error('Sign in to venmo.com in this Chrome, then sync again.');

    const end = iso(now);
    const start = status.lastDate ? iso(new Date(Date.parse(`${status.lastDate}T12:00:00Z`) - OVERLAP_DAYS * DAY)) : iso(new Date(now.getTime() - FIRST_DAYS * DAY));
    const query = new URLSearchParams({ startDate: start, endDate: end, csv: 'true', profileId, accountType: 'personal' });
    const response = await fetch(`${VENMO}/api/statement/download?${query}`, { credentials: 'include' });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !/csv/i.test(type)) {
      if (response.status === 401 || response.status === 403) throw new Error('Sign in to venmo.com in this Chrome, then sync again.');
      throw new Error(`Venmo didn't send a statement (${response.status}). Try again later, or download it on venmo.com and import it on My money.`);
    }
    const content = await response.text();
    const result = await hub('/api/personal/venmo/import', { method: 'POST', body: JSON.stringify({ files: [{ name: `Venmo ${start} to ${end}.csv`, content }] }) });
    return { start, end, ...result };
  };

  // What a sync did, in a sentence.
  OHE.describeVenmoSync = function describeVenmoSync(r) {
    const parts = [r.added ? `Added ${r.added} Venmo ${r.added === 1 ? 'row' : 'rows'}.` : 'Nothing new in Venmo.'];
    if (r.matchedToBank) parts.push(`${r.matchedToBank} matched to the bank.`);
    if (r.unbalanced && r.unbalanced.length) parts.push("The statement didn't add up to its balance; check My money.");
    return `${parts.join(' ')} (${r.start} to ${r.end})`;
  };
})(typeof self !== 'undefined' ? self : globalThis);

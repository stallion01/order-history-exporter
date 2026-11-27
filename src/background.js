importScripts('lib/venmo.js');

// The toolbar button opens (or refocuses) the exporter page.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('src/app/app.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (contexts.length && contexts[0].tabId >= 0) {
    const tab = await chrome.tabs.update(contexts[0].tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// Chrome heavily throttles timers in hidden pages, which would slow a long
// export to one step per minute if the user switches tabs. Service worker
// timers are not throttled, so the exporter page does its waiting here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'sleep') {
    setTimeout(() => sendResponse(true), Math.min(Number(message.ms) || 0, 25000));
    return true; // keeps the channel open for the async response
  }
  return undefined;
});

// Venmo, every day or every week by itself, as chosen. Chrome checks every six hours
// and syncs when the last good sync is that old; a check missed while Chrome was closed
// happens when it next starts.
const VENMO_ALARM = 'venmo-sync';
const ensureVenmoAlarm = () => chrome.alarms.create(VENMO_ALARM, { delayInMinutes: 1, periodInMinutes: 6 * 60 });
chrome.runtime.onInstalled.addListener(ensureVenmoAlarm);
chrome.runtime.onStartup.addListener(ensureVenmoAlarm);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== VENMO_ALARM) return;
  const stored = (await chrome.storage.local.get(OHE.VENMO_KEY))[OHE.VENMO_KEY];
  const every = stored ? (stored.every ?? OHE.VENMO_EVERY_DAYS) : 0;
  if (!stored || !every || !stored.url || !stored.key) return;
  const due = !stored.lastSuccess || Date.now() - Date.parse(stored.lastSuccess) >= every * 86400000 - 3600000;
  if (!due) return;
  const at = new Date().toISOString();
  try {
    const result = await OHE.venmoSync(stored);
    await chrome.storage.local.set({ [OHE.VENMO_KEY]: { ...stored, lastSuccess: at, lastTry: at, lastMessage: OHE.describeVenmoSync(result) } });
  } catch (err) {
    await chrome.storage.local.set({ [OHE.VENMO_KEY]: { ...stored, lastTry: at, lastMessage: err.message } });
  }
});

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

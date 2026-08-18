// MV3 service worker. Deliberately thin: it terminates after ~30s idle, so it
// owns nothing stateful. The dashboard is an extension page with full chrome.*
// access and talks to the libs directly — no message-passing layer needed.

const APP_URL = chrome.runtime.getURL('src/ui/app.html');

async function openDashboard() {
  const existing = await chrome.tabs.query({ url: APP_URL });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openDashboard();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openDashboard();
});

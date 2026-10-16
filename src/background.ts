import type { Request } from "./messages";
import {
  applyOpenMode,
  closeDuplicates,
  closeTabs,
  disableProbes,
  enableProbes,
  hungerEnabled,
  loadSettings,
  recordActivation,
  refreshBadge,
  runAutoSleep,
  sleepOthers,
  sleepSelected,
  sleepSuggested,
  sleepTabs,
  undo,
} from "./tabs";

const TICK_ALARM = "doze-tick";
const TICK_MINUTES = 5;

type MenuId = "sleep-selected" | "sleep-others" | "close-duplicates";

const MENU_ITEMS: { id: MenuId; title: string }[] = [
  { id: "sleep-selected", title: "Sleep selected tabs" },
  { id: "sleep-others", title: "Sleep other tabs in this window" },
  { id: "close-duplicates", title: "Close duplicate tabs" },
];

async function run(id: string, windowId: number | undefined): Promise<void> {
  if (id === "close-duplicates") await closeDuplicates();
  else if (windowId !== undefined && id === "sleep-selected") await sleepSelected(windowId);
  else if (windowId !== undefined && id === "sleep-others") await sleepOthers(windowId);
  await refreshBadge();
}

async function handle(request: Request): Promise<void> {
  switch (request.type) {
    case "sleep":
      await sleepTabs(request.tabIds, "you");
      break;
    case "sleep-suggested":
      await sleepSuggested();
      break;
    case "close":
      await closeTabs(request.tabIds, "you");
      break;
    case "close-duplicates":
      await closeDuplicates();
      break;
    case "undo":
      await undo(request.entryId);
      break;
  }
  await refreshBadge();
}

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  }
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleBadge(): void {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => void refreshBadge(), 500);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({ ...item, contexts: ["page", "action"] });
    }
  });
  void ensureAlarm();
  void refreshBadge();
  // A reload cuts off the probes already running in open pages, so put fresh ones in.
  void hungerEnabled().then((on) => (on ? enableProbes() : undefined));
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void loadSettings().then(applyOpenMode);
});

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(request).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => sendResponse({ ok: false, error: String(error) }),
  );
  return true;
});

// The popup asks for the permission; set the probes up here because the popup can close while
// Chrome's prompt is showing.
chrome.permissions.onAdded.addListener(() => {
  void hungerEnabled().then((on) => (on ? enableProbes() : undefined));
});

chrome.permissions.onRemoved.addListener(() => {
  void hungerEnabled().then((on) => (on ? undefined : disableProbes()));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void run(String(info.menuItemId), tab?.windowId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  void (async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    await run(command, windowId);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  void runAutoSleep().then(refreshBadge);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then((tab) => recordActivation(tabId, tab.url));
  scheduleBadge();
});

chrome.tabs.onCreated.addListener(scheduleBadge);
chrome.tabs.onRemoved.addListener(scheduleBadge);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.discarded !== undefined || change.audible !== undefined) scheduleBadge();
});

void ensureAlarm();
void loadSettings().then(applyOpenMode);

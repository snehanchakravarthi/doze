// Chrome-facing layer. Actions that change tabs run in the background worker so they're logged
// and measured even if the popup closes; the popup reaches them through messages.ts.

import { MAX_ENTRIES, type ActivityEntry, type ActivityTab, type Source } from "./activity";
import {
  DEFAULT_SETTINGS,
  REGRET_HALF_LIFE_MS,
  assess,
  autoSleepCandidates,
  bumpUsage,
  hostOf,
  type Probe,
  type Settings,
  type Signals,
  type TabSnapshot,
  type Usage,
  type Verdict,
} from "./scoring";
import { pressureOf, readMemory, type Pressure } from "./system";

export interface Assessment {
  tabs: TabSnapshot[];
  verdicts: Verdict[];
  settings: Settings;
}

/** Waking a tab Doze slept within this window counts as Doze getting it wrong. */
const REGRET_WINDOW_MS = 15 * 60 * 1000;
/** Chrome needs a moment to tear down a discarded tab's process before memory shows as free. */
const MEASURE_DELAY_MS = 2500;

interface SleptRecord {
  at: number;
  host: string;
  source: Source;
}

// ---------- storage ----------

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getLocal<Partial<Settings>>("settings", {})) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

async function loadSignals(): Promise<Signals> {
  const [usage, regrets] = await Promise.all([
    getLocal<Usage>("usage", {}),
    getLocal<Usage>("regrets", {}),
  ]);
  return { usage, regrets };
}

export async function loadActivity(): Promise<ActivityEntry[]> {
  return getLocal<ActivityEntry[]>("activity", []);
}

// Activity writes are read-modify-write, so run them one at a time.
let activityQueue: Promise<unknown> = Promise.resolve();
function editActivity(edit: (entries: ActivityEntry[]) => ActivityEntry[]): Promise<void> {
  const next = activityQueue.then(async () => {
    const entries = edit(await loadActivity()).slice(0, MAX_ENTRIES);
    await chrome.storage.local.set({ activity: entries });
  });
  activityQueue = next.catch(() => undefined);
  return next;
}

function updateEntry(id: string, patch: Partial<ActivityEntry>): Promise<void> {
  return editActivity((entries) => entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

async function loadSlept(): Promise<Record<string, SleptRecord>> {
  const { slept } = await chrome.storage.session.get("slept");
  return (slept as Record<string, SleptRecord> | undefined) ?? {};
}

/** The toolbar icon opens either the popup or the side panel, per the setting. */
export async function applyOpenMode(settings: Settings): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: settings.openInPanel });
  // A popup always wins over the panel behaviour, so remove it when the panel should open.
  await chrome.action.setPopup({ popup: settings.openInPanel ? "" : "popup.html" });
}

// ---------- hunger meter (in-page probes) ----------

const HUNGER_PERMISSION: chrome.permissions.Permissions = { origins: ["<all_urls>"] };
const PROBE_SCRIPT_ID = "doze-probe";
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 400;

interface CachedProbe {
  at: number;
  probe: Probe | null;
}

export async function hungerEnabled(): Promise<boolean> {
  return chrome.permissions.contains(HUNGER_PERMISSION);
}

/** Must run from a click in the popup: Chrome only shows the permission prompt for a user gesture. */
export async function requestHunger(): Promise<boolean> {
  return chrome.permissions.request(HUNGER_PERMISSION);
}

export async function turnOffHunger(): Promise<void> {
  await chrome.permissions.remove(HUNGER_PERMISSION);
}

function isWebTab(tab: chrome.tabs.Tab): boolean {
  return /^https?:/.test(tab.url ?? "") && !tab.discarded && tab.status !== "unloaded";
}

export async function enableProbes(): Promise<void> {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [PROBE_SCRIPT_ID] });
  if (registered.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: PROBE_SCRIPT_ID,
        matches: ["<all_urls>"],
        js: ["probe.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  }
  // Pages that were already open only get the registered script when they reload, so add it now.
  const open = (await chrome.tabs.query({})).filter(isWebTab);
  await Promise.allSettled(
    open.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id ?? -1 }, files: ["probe.js"] }),
    ),
  );
}

export async function disableProbes(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [PROBE_SCRIPT_ID] }).catch(() => undefined);
  await chrome.storage.session.remove("probes");
}

async function probeTab(tabId: number): Promise<Probe | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS));
  const reply = chrome.tabs
    .sendMessage(tabId, { type: "doze-probe" })
    .then((probe: Probe | undefined) => probe ?? null)
    .catch(() => null);
  return Promise.race([reply, timeout]);
}

/** Readings for every awake web tab, re-asking a page at most once a minute. */
async function loadProbes(tabs: chrome.tabs.Tab[]): Promise<Map<number, Probe>> {
  if (!(await hungerEnabled())) return new Map();
  const { probes } = await chrome.storage.session.get("probes");
  const cache: Record<string, CachedProbe> = { ...(probes as Record<string, CachedProbe>) };
  const now = Date.now();
  const live = tabs.filter((tab) => tab.id !== undefined && isWebTab(tab));
  const stale = live.filter((tab) => {
    const cached = cache[tab.id ?? -1];
    return !cached || now - cached.at > PROBE_TTL_MS;
  });

  const fresh = await Promise.all(
    stale.map(async (tab) => [tab.id ?? -1, await probeTab(tab.id ?? -1)] as const),
  );
  for (const [id, probe] of fresh) cache[id] = { at: now, probe };
  const liveIds = new Set(live.map((tab) => String(tab.id)));
  for (const id of Object.keys(cache)) if (!liveIds.has(id)) delete cache[id];
  if (fresh.length > 0) await chrome.storage.session.set({ probes: cache });

  return new Map(
    Object.entries(cache).flatMap(([id, cached]) =>
      cached.probe ? [[Number(id), cached.probe] as const] : [],
    ),
  );
}

// ---------- snapshots ----------

function toSnapshot(tab: chrome.tabs.Tab, probe: Probe | null): TabSnapshot | null {
  if (tab.id === undefined) return null;
  return {
    probe,
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible ?? false,
    asleep: tab.discarded || tab.status === "unloaded",
    autoDiscardable: tab.autoDiscardable,
    lastAccessed: tab.lastAccessed ?? Date.now(),
  };
}

export async function currentAssessment(): Promise<Assessment> {
  const [rawTabs, signals, settings] = await Promise.all([
    chrome.tabs.query({}),
    loadSignals(),
    loadSettings(),
  ]);
  const probes = await loadProbes(rawTabs);
  const tabs = rawTabs
    .map((tab) => toSnapshot(tab, probes.get(tab.id ?? -1) ?? null))
    .filter((tab): tab is TabSnapshot => tab !== null);
  return { tabs, verdicts: assess(tabs, signals, settings, Date.now()), settings };
}

// ---------- logged actions ----------

async function describeTabs(tabIds: number[]): Promise<ActivityTab[]> {
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)));
  return tabs.flatMap((tab) =>
    tab?.id === undefined
      ? []
      : [{ id: tab.id, windowId: tab.windowId, url: tab.url ?? "", title: tab.title ?? "" }],
  );
}

async function logAndMeasure(
  kind: "sleep" | "close",
  source: Source,
  tabs: ActivityTab[],
  freeBefore: number,
): Promise<void> {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind,
    source,
    tabs,
    freedBytes: null,
    measuring: true,
    undone: false,
  };
  await editActivity((entries) => [entry, ...entries]);
  await new Promise((resolve) => setTimeout(resolve, MEASURE_DELAY_MS));
  const after = await readMemory().catch(() => null);
  await updateEntry(entry.id, {
    measuring: false,
    freedBytes: after ? Math.max(0, after.available - freeBefore) : null,
  });
  await refreshBadge();
}

/** Discards tabs, logs the action and measures the memory it freed. Returns how many slept. */
export async function sleepTabs(tabIds: number[], source: Source): Promise<number> {
  if (tabIds.length === 0) return 0;
  const details = await describeTabs(tabIds);
  const before = await readMemory();
  const results = await Promise.allSettled(tabIds.map((id) => chrome.tabs.discard(id)));

  // Chrome may give a discarded tab a new id, so track the id it returns.
  const now = Date.now();
  const slept = await loadSlept();
  const sleptTabs: ActivityTab[] = [];
  results.forEach((result, index) => {
    const original = details.find((tab) => tab.id === tabIds[index]);
    if (result.status !== "fulfilled" || result.value?.id === undefined || !original) return;
    const tab = { ...original, id: result.value.id };
    slept[tab.id] = { at: now, host: hostOf(tab.url), source };
    sleptTabs.push(tab);
  });
  if (sleptTabs.length === 0) return 0;
  await chrome.storage.session.set({ slept });

  void logAndMeasure("sleep", source, sleptTabs, before.available);
  return sleptTabs.length;
}

export async function closeTabs(tabIds: number[], source: Source): Promise<number> {
  if (tabIds.length === 0) return 0;
  const details = await describeTabs(tabIds);
  const before = await readMemory();
  await chrome.tabs.remove(tabIds);
  void logAndMeasure("close", source, details, before.available);
  return details.length;
}

/** Sleeps the tabs the user multi-selected (Cmd/Shift-click) in a window. */
export async function sleepSelected(windowId: number): Promise<number> {
  const [selected, { verdicts }] = await Promise.all([
    chrome.tabs.query({ windowId, highlighted: true }),
    currentAssessment(),
  ]);
  const selectedIds = new Set(selected.map((tab) => tab.id));
  // Pinned and kept-awake tabs are fine to sleep on request; never lose audio or unsaved typing.
  const skip = new Set(["active", "asleep", "audible", "unsaved"]);
  const ids = verdicts
    .filter((v) => selectedIds.has(v.tabId) && !skip.has(v.protection ?? ""))
    .map((v) => v.tabId);
  return sleepTabs(ids, "you");
}

/** Sleeps every unprotected tab in a window, however recently it was used. */
export async function sleepOthers(windowId: number): Promise<number> {
  const { tabs, verdicts } = await currentAssessment();
  const inWindow = new Set(tabs.filter((tab) => tab.windowId === windowId).map((tab) => tab.id));
  return sleepTabs(
    verdicts.filter((v) => inWindow.has(v.tabId) && v.protection === null).map((v) => v.tabId),
    "you",
  );
}

export async function sleepSuggested(): Promise<number> {
  const { verdicts } = await currentAssessment();
  return sleepTabs(verdicts.filter((v) => v.suggested).map((v) => v.tabId), "suggested");
}

export async function closeDuplicates(): Promise<number> {
  const { verdicts } = await currentAssessment();
  const ids = verdicts
    .filter((v) => v.duplicateOf !== null && v.protection !== "active" && v.protection !== "audible")
    .map((v) => v.tabId);
  return closeTabs(ids, "you");
}

export async function runAutoSleep(): Promise<number> {
  const { verdicts, settings } = await currentAssessment();
  return sleepTabs(autoSleepCandidates(verdicts, settings), "auto");
}

// ---------- undo ----------

export async function undo(entryId: string): Promise<void> {
  const entry = (await loadActivity()).find((e) => e.id === entryId);
  if (!entry || entry.undone) return;

  if (entry.kind === "sleep") {
    const slept = await loadSlept();
    for (const tab of entry.tabs) delete slept[tab.id];
    await chrome.storage.session.set({ slept });
    await Promise.allSettled(entry.tabs.map((tab) => chrome.tabs.reload(tab.id)));
  } else if (entry.kind === "close") {
    await Promise.allSettled(
      entry.tabs.map((tab) =>
        chrome.tabs
          .create({ url: tab.url, windowId: tab.windowId, active: false })
          .catch(() => chrome.tabs.create({ url: tab.url, active: false })),
      ),
    );
  } else if (entry.host) {
    const regrets = await getLocal<Usage>("regrets", {});
    regrets[entry.host] = bumpUsage(regrets[entry.host], Date.now(), REGRET_HALF_LIFE_MS, -1);
    await chrome.storage.local.set({ regrets });
  }
  await updateEntry(entry.id, { undone: true });
  await refreshBadge();
}

// ---------- learning ----------

/** Called when you switch to a tab: counts site usage, and notices when Doze slept it too early. */
export async function recordActivation(tabId: number, url: string | undefined): Promise<void> {
  const host = url ? hostOf(url) : "";
  const now = Date.now();
  if (host) {
    const usage = await getLocal<Usage>("usage", {});
    usage[host] = bumpUsage(usage[host], now);
    await chrome.storage.local.set({ usage });
  }

  const slept = await loadSlept();
  const record = slept[tabId];
  if (!record) return;
  delete slept[tabId];
  await chrome.storage.session.set({ slept });

  if (record.source === "you" || !record.host || now - record.at > REGRET_WINDOW_MS) return;
  const regrets = await getLocal<Usage>("regrets", {});
  regrets[record.host] = bumpUsage(regrets[record.host], now, REGRET_HALF_LIFE_MS);
  await chrome.storage.local.set({ regrets });
  await editActivity((entries) => [
    {
      id: crypto.randomUUID(),
      at: now,
      kind: "learned",
      source: record.source,
      tabs: [],
      freedBytes: null,
      measuring: false,
      undone: false,
      host: record.host,
    },
    ...entries,
  ]);
}

// ---------- badge ----------

const BADGE_COLORS: Record<Pressure, string> = {
  calm: "#5B5BD6",
  busy: "#D97706",
  strained: "#DC2626",
};

/** Shows how many tabs Doze would act on, coloured by how much memory pressure the Mac is under. */
export async function refreshBadge(): Promise<void> {
  const [{ verdicts }, memory] = await Promise.all([currentAssessment(), readMemory()]);
  const count = verdicts.filter(
    (v) => v.suggested || (v.duplicateOf !== null && v.protection !== "active"),
  ).length;
  await chrome.action.setBadgeBackgroundColor({
    color: BADGE_COLORS[pressureOf({ ...memory, cpu: null })],
  });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

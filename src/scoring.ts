// Pure tab-scoring logic. No chrome.* calls here so it can be unit tested.

export interface TabSnapshot {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  /** Not holding memory: discarded, or restored after a restart and never opened since. */
  asleep: boolean;
  autoDiscardable: boolean;
  lastAccessed: number;
  /** Live readings from inside the page, when the hunger meter is on and the page allows it. */
  probe?: Probe | null;
}

/** What probe.ts reports from inside a page. */
export interface Probe {
  /** Memory used by the page's JavaScript. Chrome rounds this and refreshes it slowly. */
  heapBytes: number | null;
  /** Milliseconds of long tasks per minute while the tab was in the background. */
  busyMsPerMin: number;
  /** A text field you typed into still has text in it. */
  unsaved: boolean;
}

export type AppetiteLevel = 1 | 2 | 3 | 4;

export interface Appetite {
  level: AppetiteLevel;
  memory: "light" | "moderate" | "heavy" | "very heavy" | "unknown";
  busy: boolean;
}

export interface Settings {
  /** Minutes of inactivity before a tab is slept automatically. 0 turns auto-sleep off. */
  autoSleepMinutes: number;
  protectPinned: boolean;
  neverSleepHosts: string[];
  /** Clicking the toolbar icon opens the side panel instead of the popup. */
  openInPanel: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoSleepMinutes: 60,
  protectPinned: true,
  neverSleepHosts: [],
  openInPanel: false,
};

/** Exponentially decayed count of events for a site. */
export interface UsageEntry {
  score: number;
  at: number;
}
export type Usage = Record<string, UsageEntry>;

/** What Doze has learned about each site from your behaviour. */
export interface Signals {
  /** How often you focus the site. */
  usage: Usage;
  /** How often you reopened the site soon after Doze slept it. */
  regrets: Usage;
}

export type Protection =
  | "active"
  | "audible"
  | "unsaved"
  | "pinned"
  | "kept"
  | "excluded"
  | "asleep";

export type ReasonKind = "idle" | "duplicate" | "heavy" | "busy" | "frequent" | "learned";

export interface Reason {
  kind: ReasonKind;
  label: string;
}

export interface Verdict {
  tabId: number;
  /** 0–100. Higher means a better candidate for sleeping. */
  score: number;
  protection: Protection | null;
  reasons: Reason[];
  /** Id of the copy that should stay open when this tab duplicates another. */
  duplicateOf: number | null;
  idleMinutes: number;
  /** Multiplies the auto-sleep limit for sites you use often or keep reopening. */
  graceMultiplier: number;
  /** How hungry the tab is, from in-page readings. Null when Doze can't measure it. */
  appetite: Appetite | null;
  suggested: boolean;
}

export const SUGGEST_THRESHOLD = 40;

export const USAGE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
export const REGRET_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const FREQUENT_USAGE = 6;
const LEARNED_REGRETS = 0.5;
const POINTS_PER_REGRET = 12;
const MAX_REGRET_POINTS = 30;
const IDLE_MAX_POINTS = 60;
const IDLE_SATURATION_MINUTES = 8 * 60;
const IDLE_REASON_MINUTES = 10;
const FREQUENT_AUTO_SLEEP_MULTIPLIER = 3;

// Sites that typically hold a lot of memory or keep running scripts in the background.
const HEAVY_HOSTS = [
  "youtube.com",
  "figma.com",
  "docs.google.com",
  "mail.google.com",
  "meet.google.com",
  "notion.so",
  "app.slack.com",
  "discord.com",
  "web.whatsapp.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "linkedin.com",
  "reddit.com",
  "miro.com",
  "canva.com",
  "netflix.com",
  "twitch.tv",
  "chatgpt.com",
  "claude.ai",
];

export const PROTECTION_LABELS: Record<Protection, string> = {
  active: "Open now",
  audible: "Playing audio",
  unsaved: "Has unsaved typing",
  pinned: "Pinned",
  kept: "You keep this site awake",
  excluded: "Asked to stay loaded",
  asleep: "Asleep",
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function matchesHost(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

/** Collapses URLs that show the same page: drops the fragment, tracking params, `www.` and a trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/.test(key)) parsed.searchParams.delete(key);
    }
    const text = parsed.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  } catch {
    return url;
  }
}

export function decayedUsage(
  entry: UsageEntry | undefined,
  now: number,
  halfLife = USAGE_HALF_LIFE_MS,
): number {
  if (!entry) return 0;
  return entry.score * 0.5 ** (Math.max(0, now - entry.at) / halfLife);
}

export function bumpUsage(
  entry: UsageEntry | undefined,
  now: number,
  halfLife = USAGE_HALF_LIFE_MS,
  amount = 1,
): UsageEntry {
  return { score: Math.max(0, decayedUsage(entry, now, halfLife) + amount), at: now };
}

export function formatIdle(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

const MB = 1024 ** 2;
// JS heap sizes where a tab steps up a dot. Whole-tab memory is usually 1.5–3× the JS heap.
const HEAP_STEPS = [40 * MB, 120 * MB, 300 * MB];
const MEMORY_WORDS = ["light", "moderate", "heavy", "very heavy"] as const;
const BUSY_MS_PER_MIN = 300;
const VERY_BUSY_MS_PER_MIN = 1500;

/** Folds in-page readings into 1–4 dots: more dots, hungrier tab. */
export function appetiteOf(probe: Probe | null | undefined): Appetite | null {
  if (!probe) return null;
  const busy = probe.busyMsPerMin >= BUSY_MS_PER_MIN;
  const cpuLevel = probe.busyMsPerMin >= VERY_BUSY_MS_PER_MIN ? 4 : busy ? 3 : 1;
  if (probe.heapBytes === null) {
    return busy ? { level: cpuLevel as AppetiteLevel, memory: "unknown", busy } : null;
  }
  const heap = probe.heapBytes;
  const memoryLevel = 1 + HEAP_STEPS.filter((step) => heap >= step).length;
  return {
    level: Math.max(memoryLevel, cpuLevel) as AppetiteLevel,
    memory: MEMORY_WORDS[memoryLevel - 1] ?? "light",
    busy,
  };
}

function idlePoints(minutes: number): number {
  const ratio = Math.log(1 + minutes / 10) / Math.log(1 + IDLE_SATURATION_MINUTES / 10);
  return IDLE_MAX_POINTS * Math.min(1, ratio);
}

function protectionFor(tab: TabSnapshot, host: string, settings: Settings): Protection | null {
  if (tab.active) return "active";
  if (tab.asleep) return "asleep";
  if (tab.audible) return "audible";
  if (tab.probe?.unsaved) return "unsaved";
  if (tab.pinned && settings.protectPinned) return "pinned";
  if (settings.neverSleepHosts.some((pattern) => matchesHost(host, pattern))) return "kept";
  if (!tab.autoDiscardable) return "excluded";
  return null;
}

/** Maps each duplicated tab to the copy worth keeping: the active one, else the most recently used. */
function findDuplicates(tabs: TabSnapshot[]): Map<number, number> {
  const groups = new Map<string, TabSnapshot[]>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const key = normalizeUrl(tab.url);
    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }

  const duplicateOf = new Map<number, number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.reduce((best, tab) => {
      if (tab.active !== best.active) return tab.active ? tab : best;
      return tab.lastAccessed > best.lastAccessed ? tab : best;
    });
    for (const tab of group) if (tab.id !== keeper.id) duplicateOf.set(tab.id, keeper.id);
  }
  return duplicateOf;
}

export function assess(
  tabs: TabSnapshot[],
  signals: Signals,
  settings: Settings,
  now: number,
): Verdict[] {
  const duplicates = findDuplicates(tabs);

  return tabs.map((tab) => {
    const host = hostOf(tab.url);
    const idleMinutes = Math.max(0, (now - tab.lastAccessed) / 60_000);
    const duplicateOf = duplicates.get(tab.id) ?? null;
    const frequent = host !== "" && decayedUsage(signals.usage[host], now) >= FREQUENT_USAGE;
    const regrets = host ? decayedUsage(signals.regrets[host], now, REGRET_HALF_LIFE_MS) : 0;
    const learned = regrets >= LEARNED_REGRETS;
    const appetite = appetiteOf(tab.probe);
    // Real readings beat the list of usually-heavy sites when we have them.
    const heavy =
      appetite && appetite.memory !== "unknown"
        ? appetite.memory === "heavy" || appetite.memory === "very heavy"
        : HEAVY_HOSTS.some((pattern) => matchesHost(host, pattern));
    const reasons: Reason[] = [];
    let score = idlePoints(idleMinutes);

    if (idleMinutes >= IDLE_REASON_MINUTES) {
      reasons.push({ kind: "idle", label: `Last used ${formatIdle(idleMinutes)} ago` });
    }
    if (duplicateOf !== null) {
      score += 30;
      reasons.push({ kind: "duplicate", label: "Duplicate" });
    }
    if (heavy && idleMinutes >= IDLE_REASON_MINUTES) {
      score += 10;
      reasons.push({ kind: "heavy", label: appetite ? "Uses a lot of memory" : "Heavy site" });
    }
    if (appetite?.busy && !tab.active) {
      score += 15;
      reasons.push({ kind: "busy", label: "Busy in background" });
    }
    if (frequent) {
      score -= 15;
      reasons.push({ kind: "frequent", label: "You use it often" });
    }
    if (learned) {
      score -= Math.min(MAX_REGRET_POINTS, POINTS_PER_REGRET * regrets);
      reasons.push({ kind: "learned", label: "You reopen it after sleeps" });
    }

    score = Math.round(Math.min(100, Math.max(0, score)));
    const protection = protectionFor(tab, host, settings);

    return {
      tabId: tab.id,
      score,
      protection,
      reasons,
      duplicateOf,
      idleMinutes,
      graceMultiplier: (frequent ? FREQUENT_AUTO_SLEEP_MULTIPLIER : 1) * (1 + (learned ? regrets : 0)),
      appetite,
      // Duplicates are offered for closing instead, so they never count as "ready to sleep".
      suggested: protection === null && duplicateOf === null && score >= SUGGEST_THRESHOLD,
    };
  });
}

/** Tabs idle past the auto-sleep limit. Sites used often or reopened after sleeps get longer. */
export function autoSleepCandidates(verdicts: Verdict[], settings: Settings): number[] {
  if (settings.autoSleepMinutes <= 0) return [];
  return verdicts
    .filter(
      (verdict) =>
        verdict.protection === null &&
        verdict.idleMinutes >= settings.autoSleepMinutes * verdict.graceMultiplier,
    )
    .map((verdict) => verdict.tabId);
}

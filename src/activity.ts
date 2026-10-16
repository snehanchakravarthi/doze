// The activity log: what Doze did, how much memory it freed and how to undo it.

/** Who triggered an action. Only Doze's own calls ("suggested" and "auto") can be wrong. */
export type Source = "you" | "suggested" | "auto";

export type ActivityKind = "sleep" | "close" | "learned";

export interface ActivityTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
}

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  source: Source;
  tabs: ActivityTab[];
  /** Rise in free memory measured shortly after the action. Null while measuring or if unknown. */
  freedBytes: number | null;
  measuring: boolean;
  undone: boolean;
  /** For "learned" entries: the site Doze will now treat more carefully. */
  host?: string;
}

export const UNDO_WINDOW_MS = 60 * 60 * 1000;
export const MAX_ENTRIES = 300;
const MIN_SAMPLES_FOR_ESTIMATE = 3;

export function canUndo(entry: ActivityEntry, now: number): boolean {
  if (entry.undone) return false;
  if (entry.kind === "learned") return true;
  return now - entry.at <= UNDO_WINDOW_MS;
}

/** Average memory freed per slept tab, from past measurements. Null until there's enough history. */
export function bytesPerTab(entries: ActivityEntry[]): number | null {
  const measured = entries.filter(
    (e) => e.kind === "sleep" && !e.measuring && e.freedBytes !== null && e.tabs.length > 0,
  );
  if (measured.length < MIN_SAMPLES_FOR_ESTIMATE) return null;
  const bytes = measured.reduce((sum, e) => sum + (e.freedBytes ?? 0), 0);
  const tabs = measured.reduce((sum, e) => sum + e.tabs.length, 0);
  return bytes / tabs;
}

export function totalsSince(
  entries: ActivityEntry[],
  since: number,
): { bytes: number; slept: number; closed: number } {
  const recent = entries.filter((e) => e.at >= since && !e.undone);
  return {
    bytes: recent.reduce((sum, e) => sum + (e.freedBytes ?? 0), 0),
    slept: recent.filter((e) => e.kind === "sleep").reduce((sum, e) => sum + e.tabs.length, 0),
    closed: recent.filter((e) => e.kind === "close").reduce((sum, e) => sum + e.tabs.length, 0),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function describe(entry: ActivityEntry): string {
  if (entry.kind === "learned") {
    return `You reopened ${entry.host} soon after I slept it. I'll keep it awake longer.`;
  }
  const verb = entry.kind === "sleep" ? "Slept" : "Closed";
  const lead = entry.tabs.length === 1 ? `${verb} “${entry.tabs[0]?.title || entry.tabs[0]?.url}”` : `${verb} ${plural(entry.tabs.length, "tab")}`;
  return entry.source === "auto" ? `${lead} you weren't using` : lead;
}

export const SOURCE_LABELS: Record<Source, string> = {
  you: "You",
  suggested: "Suggested",
  auto: "Automatic",
};

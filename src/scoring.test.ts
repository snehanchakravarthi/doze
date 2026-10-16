import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  appetiteOf,
  assess,
  autoSleepCandidates,
  bumpUsage,
  decayedUsage,
  normalizeUrl,
  type TabSnapshot,
  type Verdict,
} from "./scoring";

const NOW = 1_800_000_000_000;
const NO_SIGNALS = { usage: {}, regrets: {} };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let nextId = 1;
function tab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id: nextId++,
    windowId: 1,
    url: `https://example.com/page-${nextId}`,
    title: "Page",
    active: false,
    pinned: false,
    audible: false,
    asleep: false,
    autoDiscardable: true,
    lastAccessed: NOW,
    ...overrides,
  };
}

function verdictFor(verdicts: Verdict[], target: TabSnapshot): Verdict {
  const verdict = verdicts.find((v) => v.tabId === target.id);
  if (!verdict) throw new Error(`No verdict for tab ${target.id}`);
  return verdict;
}

describe("normalizeUrl", () => {
  test("ignores fragments, tracking params, www and trailing slashes", () => {
    expect(normalizeUrl("https://www.example.com/a/?utm_source=x&fbclid=1#top")).toBe(
      "https://example.com/a",
    );
  });

  test("keeps meaningful query params", () => {
    expect(normalizeUrl("https://youtube.com/watch?v=abc")).not.toBe(
      normalizeUrl("https://youtube.com/watch?v=xyz"),
    );
  });
});

describe("assess", () => {
  test("idle time raises the score", () => {
    const fresh = tab({ lastAccessed: NOW - 5 * MINUTE });
    const stale = tab({ lastAccessed: NOW - 6 * 60 * MINUTE });
    const verdicts = assess([fresh, stale], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdictFor(verdicts, stale).score).toBeGreaterThan(verdictFor(verdicts, fresh).score);
    expect(verdictFor(verdicts, fresh).suggested).toBe(false);
    expect(verdictFor(verdicts, stale).suggested).toBe(true);
  });

  test("keeps the most recently used duplicate and flags the rest", () => {
    const older = tab({ url: "https://example.com/doc#a", lastAccessed: NOW - DAY });
    const newer = tab({ url: "https://www.example.com/doc", lastAccessed: NOW - MINUTE });
    const verdicts = assess([older, newer], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdictFor(verdicts, older).duplicateOf).toBe(newer.id);
    expect(verdictFor(verdicts, newer).duplicateOf).toBeNull();
  });

  test("an active duplicate is always the keeper", () => {
    const active = tab({ url: "https://example.com/x", active: true, lastAccessed: NOW - DAY });
    const other = tab({ url: "https://example.com/x", lastAccessed: NOW });
    const verdicts = assess([active, other], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdictFor(verdicts, other).duplicateOf).toBe(active.id);
  });

  test("protects active, audible, pinned, kept and asleep tabs", () => {
    const old = NOW - 2 * DAY;
    const tabs = [
      tab({ active: true, lastAccessed: old }),
      tab({ audible: true, lastAccessed: old }),
      tab({ pinned: true, lastAccessed: old }),
      tab({ url: "https://mail.example.org/inbox", lastAccessed: old }),
      tab({ asleep: true, lastAccessed: old }),
    ];
    const settings = { ...DEFAULT_SETTINGS, neverSleepHosts: ["example.org"] };
    const protections = assess(tabs, NO_SIGNALS, settings, NOW).map((v) => v.protection);
    expect(protections).toEqual(["active", "audible", "pinned", "kept", "asleep"]);
  });

  test("pinned tabs can be slept when protection is off", () => {
    const pinned = tab({ pinned: true, lastAccessed: NOW - DAY });
    const [verdict] = assess([pinned], NO_SIGNALS, { ...DEFAULT_SETTINGS, protectPinned: false }, NOW);
    expect(verdict?.protection).toBeNull();
  });

  test("frequently used sites score lower", () => {
    const usage = { "example.com": { score: 10, at: NOW } };
    const t = tab({ lastAccessed: NOW - 3 * 60 * MINUTE });
    const [withUsage] = assess([t], { usage, regrets: {} }, DEFAULT_SETTINGS, NOW);
    const [without] = assess([t], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(withUsage?.reasons.some((r) => r.kind === "frequent")).toBe(true);
    expect(withUsage!.score).toBeLessThan(without!.score);
  });
});

describe("usage", () => {
  test("halves every three days", () => {
    expect(decayedUsage({ score: 8, at: NOW }, NOW + 3 * DAY)).toBeCloseTo(4);
  });

  test("bump adds one to the decayed value", () => {
    expect(bumpUsage({ score: 8, at: NOW }, NOW + 3 * DAY).score).toBeCloseTo(5);
    expect(bumpUsage(undefined, NOW).score).toBe(1);
  });
});

describe("autoSleepCandidates", () => {
  test("uses a longer limit for frequent sites and skips protected tabs", () => {
    const usage = { "often.com": { score: 10, at: NOW } };
    const plain = tab({ lastAccessed: NOW - 90 * MINUTE });
    const often = tab({ url: "https://often.com/", lastAccessed: NOW - 90 * MINUTE });
    const pinned = tab({ pinned: true, lastAccessed: NOW - DAY });
    const verdicts = assess([plain, often, pinned], { usage, regrets: {} }, DEFAULT_SETTINGS, NOW);
    expect(autoSleepCandidates(verdicts, DEFAULT_SETTINGS)).toEqual([plain.id]);
  });

  test("returns nothing when auto-sleep is off", () => {
    const verdicts = assess([tab({ lastAccessed: NOW - DAY })], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(autoSleepCandidates(verdicts, { ...DEFAULT_SETTINGS, autoSleepMinutes: 0 })).toEqual(
      [],
    );
  });
});

describe("learning from regrets", () => {
  test("sites you reopen after sleeps score lower and get more grace", () => {
    const t = tab({ url: "https://figma.com/file/1", lastAccessed: NOW - 2 * 60 * MINUTE });
    const regrets = { "figma.com": { score: 2, at: NOW } };
    const [learned] = assess([t], { usage: {}, regrets }, DEFAULT_SETTINGS, NOW);
    const [plain] = assess([t], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(learned!.score).toBeLessThan(plain!.score);
    expect(learned!.reasons.some((r) => r.kind === "learned")).toBe(true);
    expect(learned!.graceMultiplier).toBeCloseTo(3);
    expect(autoSleepCandidates([learned!], DEFAULT_SETTINGS)).toEqual([]);
    expect(autoSleepCandidates([plain!], DEFAULT_SETTINGS)).toEqual([t.id]);
  });

  test("a regret below the threshold changes nothing", () => {
    const t = tab({ url: "https://figma.com/file/1", lastAccessed: NOW - 3 * 60 * MINUTE });
    const regrets = { "figma.com": { score: 0.2, at: NOW } };
    const [learned] = assess([t], { usage: {}, regrets }, DEFAULT_SETTINGS, NOW);
    expect(learned!.graceMultiplier).toBe(1);
  });
});

describe("suggestions", () => {
  test("duplicates are offered for closing, not sleeping", () => {
    const older = tab({ url: "https://example.com/doc", lastAccessed: NOW - DAY });
    const newer = tab({ url: "https://example.com/doc", lastAccessed: NOW - 3 * 60 * MINUTE });
    const verdicts = assess([older, newer], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdictFor(verdicts, older).suggested).toBe(false);
    expect(verdictFor(verdicts, newer).suggested).toBe(true);
  });
});

describe("appetite", () => {
  const MB = 1024 ** 2;
  const probe = (heapMB: number | null, busyMsPerMin = 0, unsaved = false) => ({
    heapBytes: heapMB === null ? null : heapMB * MB,
    busyMsPerMin,
    unsaved,
  });

  test("more memory means more dots", () => {
    expect(appetiteOf(probe(20))?.level).toBe(1);
    expect(appetiteOf(probe(80))?.level).toBe(2);
    expect(appetiteOf(probe(200))?.memory).toBe("heavy");
    expect(appetiteOf(probe(500))?.level).toBe(4);
  });

  test("background work raises the level even for small pages", () => {
    expect(appetiteOf(probe(20, 400))).toEqual({ level: 3, memory: "light", busy: true });
    expect(appetiteOf(probe(20, 2000))?.level).toBe(4);
  });

  test("nothing measured means no dots", () => {
    expect(appetiteOf(undefined)).toBeNull();
    expect(appetiteOf(probe(null))).toBeNull();
    expect(appetiteOf(probe(null, 2000))?.memory).toBe("unknown");
  });

  test("unsaved typing protects a tab", () => {
    const t = tab({ lastAccessed: NOW - DAY, probe: probe(50, 0, true) });
    const [verdict] = assess([t], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdict?.protection).toBe("unsaved");
    expect(autoSleepCandidates([verdict!], DEFAULT_SETTINGS)).toEqual([]);
  });

  test("busy tabs score higher and measured memory replaces the site list", () => {
    const busy = tab({ lastAccessed: NOW - 30 * MINUTE, probe: probe(30, 800) });
    const calm = tab({ lastAccessed: NOW - 30 * MINUTE, probe: probe(30, 0) });
    const lightYoutube = tab({
      url: "https://youtube.com/watch?v=1",
      lastAccessed: NOW - 30 * MINUTE,
      probe: probe(30),
    });
    const verdicts = assess([busy, calm, lightYoutube], NO_SIGNALS, DEFAULT_SETTINGS, NOW);
    expect(verdictFor(verdicts, busy).score).toBeGreaterThan(verdictFor(verdicts, calm).score);
    expect(verdictFor(verdicts, lightYoutube).reasons.some((r) => r.kind === "heavy")).toBe(false);
  });
});

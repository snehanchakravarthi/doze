import { describe as group, expect, test } from "bun:test";
import { bytesPerTab, canUndo, describe, totalsSince, UNDO_WINDOW_MS, type ActivityEntry } from "./activity";
import { cpuLoad, formatBytes, headline, pressureOf } from "./system";

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: String(Math.random()),
    at: NOW,
    kind: "sleep",
    source: "you",
    tabs: [{ id: 1, windowId: 1, url: "https://a.com", title: "A" }],
    freedBytes: 0.2 * GB,
    measuring: false,
    undone: false,
    ...overrides,
  };
}

group("pressure", () => {
  test("memory and CPU thresholds", () => {
    expect(pressureOf({ capacity: 24 * GB, available: 12 * GB, cpu: 0.2 })).toBe("calm");
    expect(pressureOf({ capacity: 24 * GB, available: 4 * GB, cpu: 0.2 })).toBe("busy");
    expect(pressureOf({ capacity: 24 * GB, available: 2 * GB, cpu: 0.2 })).toBe("strained");
    expect(pressureOf({ capacity: 24 * GB, available: 12 * GB, cpu: 0.9 })).toBe("strained");
  });

  test("headline names the worst problem", () => {
    expect(headline({ capacity: 24 * GB, available: 2 * GB, cpu: 0.9 })).toBe(
      "Your Mac is low on memory",
    );
    expect(headline({ capacity: 24 * GB, available: 12 * GB, cpu: null })).toBe(
      "Everything is running smoothly",
    );
  });

  test("cpu load from two samples", () => {
    expect(cpuLoad({ idle: 100, total: 200 }, { idle: 130, total: 300 })).toBeCloseTo(0.7);
    expect(cpuLoad({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull();
  });

  test("formats bytes", () => {
    expect(formatBytes(1.44 * GB)).toBe("1.4 GB");
    expect(formatBytes(12.4 * GB)).toBe("12 GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MB");
  });
});

group("activity", () => {
  test("estimates per-tab savings only with enough history", () => {
    expect(bytesPerTab([entry(), entry()])).toBeNull();
    const twoTabs = entry({ tabs: [...entry().tabs, ...entry().tabs], freedBytes: 0.6 * GB });
    expect(bytesPerTab([entry(), entry(), twoTabs])).toBeCloseTo(0.25 * GB);
  });

  test("ignores entries still measuring and closes", () => {
    const list = [entry(), entry(), entry({ measuring: true }), entry({ kind: "close" })];
    expect(bytesPerTab(list)).toBeNull();
  });

  test("undo window", () => {
    expect(canUndo(entry(), NOW + UNDO_WINDOW_MS - 1)).toBe(true);
    expect(canUndo(entry(), NOW + UNDO_WINDOW_MS + 1)).toBe(false);
    expect(canUndo(entry({ undone: true }), NOW)).toBe(false);
    expect(canUndo(entry({ kind: "learned", at: 0 }), NOW)).toBe(true);
  });

  test("totals skip undone entries", () => {
    const totals = totalsSince(
      [entry(), entry({ undone: true }), entry({ kind: "close", freedBytes: null }), entry({ at: 0 })],
      NOW - 1000,
    );
    expect(totals).toEqual({ bytes: 0.2 * GB, slept: 1, closed: 1 });
  });

  test("describes entries", () => {
    expect(describe(entry())).toBe("Slept “A”");
    expect(describe(entry({ source: "auto", tabs: [...entry().tabs, ...entry().tabs] }))).toBe(
      "Slept 2 tabs you weren't using",
    );
  });
});

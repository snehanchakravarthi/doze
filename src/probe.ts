// Runs inside pages once you turn on the hunger meter. It only measures: how much memory the
// page's scripts hold, how much work it does while hidden, and whether a field you typed into
// still has text in it. It never reads or sends what's on the page or what you typed.

import type { Probe } from "./scoring";

const WINDOW_MS = 5 * 60 * 1000;
const IGNORED_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
]);

const busyTasks: { at: number; ms: number }[] = [];
const typedInto = new Set<Element>();

try {
  new PerformanceObserver((list) => {
    if (!document.hidden) return;
    for (const entry of list.getEntries()) busyTasks.push({ at: Date.now(), ms: entry.duration });
  }).observe({ type: "longtask" });
} catch {
  // Long-task timing isn't available in this frame; busy stays at zero.
}

document.addEventListener(
  "input",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(target.type)) return;
    if (target instanceof Element && typedInto.size < 50) typedInto.add(target);
  },
  true,
);

/** True when a field you typed into is still on the page and not empty, e.g. a half-written reply. */
function hasUnsavedText(): boolean {
  for (const element of typedInto) {
    if (!element.isConnected) {
      typedInto.delete(element);
      continue;
    }
    const filled =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value.trim().length > 0
        : (element as HTMLElement).isContentEditable && (element.textContent ?? "").trim().length > 0;
    if (filled) return true;
    typedInto.delete(element);
  }
  return false;
}

function readHeap(): number | null {
  // Chrome-only and deliberately coarse: values are rounded and refresh every few minutes.
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory?.usedJSHeapSize ?? null;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, reply) => {
  if ((message as { type?: string } | null)?.type !== "doze-probe") return false;
  const now = Date.now();
  while (busyTasks.length > 0 && now - (busyTasks[0]?.at ?? now) > WINDOW_MS) busyTasks.shift();
  const busyMs = busyTasks.reduce((sum, task) => sum + task.ms, 0);
  const probe: Probe = {
    heapBytes: readHeap(),
    busyMsPerMin: busyMs / (WINDOW_MS / 60_000),
    unsaved: hasUnsavedText(),
  };
  reply(probe);
  return false;
});

import {
  SOURCE_LABELS,
  bytesPerTab,
  canUndo,
  describe,
  totalsSince,
  type ActivityEntry,
} from "./activity";
import { send } from "./messages";
import {
  PROTECTION_LABELS,
  formatIdle,
  hostOf,
  matchesHost,
  type Appetite,
  type TabSnapshot,
  type Verdict,
} from "./scoring";
import {
  cpuLoad,
  formatBytes,
  headline,
  pressureOf,
  readCpu,
  readMemory,
  type CpuSample,
  type Vitals,
} from "./system";
import {
  currentAssessment,
  hungerEnabled,
  loadActivity,
  requestHunger,
  saveSettings,
  turnOffHunger,
  type Assessment,
} from "./tabs";

const ICONS = {
  sleep:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z"/></svg>',
  keep: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.75 2.75 4v4c0 3 2.25 5.25 5.25 6.25 3-1 5.25-3.25 5.25-6.25V4L8 1.75Z"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  unkeep:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.75 2.75 4v4c0 3 2.25 5.25 5.25 6.25 3-1 5.25-3.25 5.25-6.25V4L8 1.75Z"/><path d="m2 2 12 12"/></svg>',
  learned:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1"/></svg>',
} as const;

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 20;
const TOAST_MS = 2 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LEAVE_MS = 160;

type ActionKey = "sleep" | "keep" | "unkeep" | "close";

interface RowAction {
  key: ActionKey;
  icon: keyof typeof ICONS;
  label: string;
  run: () => Promise<unknown>;
}

interface Entry {
  tab: TabSnapshot;
  verdict: Verdict;
}

interface NavRow {
  tabId: number;
  row: HTMLLIElement;
  tab: TabSnapshot;
  actions: RowAction[];
}

const byId = <T extends Element>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as unknown as T;
};

const gauge = byId<HTMLDivElement>("gauge");
const gaugeFill = byId<SVGCircleElement>("gauge-fill");
const gaugeValue = byId<HTMLSpanElement>("gauge-value");
const headlineEl = byId<HTMLParagraphElement>("headline");
const vitalsEl = byId<HTMLParagraphElement>("vitals");
const insightEl = byId<HTMLParagraphElement>("insight");
const sleepButton = byId<HTMLButtonElement>("sleep-suggested");
const dupesButton = byId<HTMLButtonElement>("close-duplicates");
const toast = byId<HTMLDivElement>("toast");
const toastText = byId<HTMLSpanElement>("toast-text");
const toastUndo = byId<HTMLButtonElement>("toast-undo");
const search = byId<HTMLInputElement>("search");
const lists = byId<HTMLElement>("lists");
const activityView = byId<HTMLElement>("activity");
const settingsToggle = byId<HTMLButtonElement>("settings-toggle");
const settingsPanel = byId<HTMLElement>("settings");
const autoSleep = byId<HTMLSelectElement>("auto-sleep");
const protectPinned = byId<HTMLInputElement>("protect-pinned");
const keptHosts = byId<HTMLUListElement>("kept-hosts");
const hungerOffer = byId<HTMLDivElement>("hunger-offer");
const hungerOn = byId<HTMLButtonElement>("hunger-on");
const hungerLater = byId<HTMLButtonElement>("hunger-later");
const hungerToggle = byId<HTMLInputElement>("hunger");
const openPanel = byId<HTMLButtonElement>("open-panel");
const openInPanel = byId<HTMLInputElement>("open-in-panel");
const isPanel = document.body.classList.contains("panel");
const viewTabs = [...document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]")];

let state: Assessment | undefined;
let activity: ActivityEntry[] = [];
let vitals: Vitals | null = null;
let lastCpu: CpuSample | null = null;
let view: "tabs" | "activity" = "tabs";
let navRows: NavRow[] = [];
let cursorId: number | null = null;
let cursorIndex = 0;
let windowId: number | undefined;
let toastShown: { id: string; freed: number | null } | null = null;
// Remembers which collapsible sections the user opened, so re-renders keep them.
const openSections = new Map<string, boolean>();

// ---------- helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function ago(at: number): string {
  const minutes = (Date.now() - at) / 60_000;
  return minutes < 1 ? "just now" : `${formatIdle(minutes)} ago`;
}

function faviconUrl(pageUrl: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
}

const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

async function leave(rows: HTMLElement[]): Promise<void> {
  if (rows.length === 0 || reducedMotion()) return;
  for (const row of rows) row.classList.add("leaving");
  await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
}

async function act(work: () => Promise<unknown>): Promise<void> {
  await work();
  await render();
}

function countUp(target: HTMLElement, bytes: number): void {
  if (reducedMotion()) {
    target.textContent = formatBytes(bytes);
    return;
  }
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / 600);
    target.textContent = formatBytes(bytes * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- hero & insight ----------

async function updateVitals(): Promise<void> {
  const [memory, cpu] = await Promise.all([readMemory(), readCpu()]);
  const load = lastCpu ? cpuLoad(lastCpu, cpu) : null;
  lastCpu = cpu;
  vitals = { ...memory, cpu: load ?? vitals?.cpu ?? null };
  renderHero();
  renderInsight();
}

function renderHero(): void {
  if (!vitals) return;
  const used = 1 - vitals.available / vitals.capacity;
  gauge.dataset.pressure = pressureOf(vitals);
  gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - used));
  gaugeValue.textContent = `${Math.round(used * 100)}%`;
  headlineEl.textContent = headline(vitals);
  const cpu = vitals.cpu === null ? "" : ` · CPU ${Math.round(vitals.cpu * 100)}%`;
  vitalsEl.textContent = `${formatBytes(vitals.available)} of ${formatBytes(vitals.capacity)} memory free${cpu}`;
}

function renderInsight(): void {
  if (!state) return;
  const suggested = state.verdicts.filter((v) => v.suggested).length;
  const asleep = state.tabs.filter((t) => t.asleep).length;
  const perTab = bytesPerTab(activity);
  const week = totalsSince(activity, Date.now() - WEEK_MS);
  const pressure = vitals ? pressureOf(vitals) : "calm";

  const duplicates = state.verdicts.filter(
    (v) => v.duplicateOf !== null && v.protection !== "active",
  ).length;

  if (suggested > 0) {
    const verb = suggested === 1 ? "is" : "are";
    const dupes = duplicates > 0 ? `, plus ${plural(duplicates, "duplicate")} to close` : "";
    insightEl.textContent = perTab
      ? `${plural(suggested, "tab")} ${verb} ready to sleep${dupes}. Sleeping them should free about ${formatBytes(perTab * suggested)}.`
      : `${plural(suggested, "tab")} ${verb} ready to sleep${dupes}.`;
  } else if (duplicates > 0) {
    insightEl.textContent = `${plural(duplicates, "duplicate tab")} can be closed. The copy you used last stays open.`;
  } else if (pressure !== "calm") {
    insightEl.textContent =
      "Your idle tabs are already asleep. Press ⌥⇧O to sleep the rest of this window too.";
  } else if (week.bytes > 0) {
    insightEl.textContent = `Nothing needs to sleep. Doze has freed about ${formatBytes(week.bytes)} this week.`;
  } else if (asleep > 0) {
    insightEl.textContent = `Nothing needs to sleep. ${plural(asleep, "tab")} ${asleep === 1 ? "is" : "are"} asleep, using almost no memory.`;
  } else {
    insightEl.textContent = "Nothing needs to sleep right now.";
  }
}

// ---------- toast ----------

function renderToast(): void {
  const latest = activity[0];
  if (!latest || latest.undone || Date.now() - latest.at > TOAST_MS) {
    toast.hidden = true;
    toastShown = null;
    return;
  }

  const previous = toastShown?.id === latest.id ? toastShown.freed : undefined;
  toastText.replaceChildren(describe(latest));
  if (latest.measuring) {
    toastText.append(" · measuring…");
  } else if (latest.freedBytes) {
    const amount = el("strong");
    toastText.append(" · freed about ", amount);
    if (previous === null) countUp(amount, latest.freedBytes);
    else amount.textContent = formatBytes(latest.freedBytes);
  }
  toastUndo.textContent = latest.kind === "learned" ? "Forget" : "Undo";
  toastUndo.hidden = !canUndo(latest, Date.now());
  toastUndo.onclick = () => void act(() => send({ type: "undo", entryId: latest.id }));
  toast.hidden = false;
  toastShown = { id: latest.id, freed: latest.freedBytes };
}

// ---------- tabs view ----------

function metaLine({ tab, verdict }: Entry): HTMLElement {
  const meta = el("div", "meta");
  const parts: (string | HTMLElement)[] = [hostOf(tab.url) || tab.url];

  if (verdict.protection && verdict.protection !== "asleep") {
    parts.push(PROTECTION_LABELS[verdict.protection]);
  } else if (verdict.idleMinutes >= 1) {
    parts.push(`Last used ${formatIdle(verdict.idleMinutes)} ago`);
  }
  for (const reason of verdict.reasons) {
    // The dots already say how heavy a measured tab is.
    if (reason.kind === "idle" || (reason.kind === "heavy" && verdict.appetite)) continue;
    parts.push(el("span", `tag ${reason.kind}`, reason.label));
  }

  parts.forEach((part, index) => {
    if (index > 0) meta.append(" · ");
    meta.append(part);
  });
  return meta;
}

function openTab(tab: TabSnapshot): void {
  void chrome.tabs.update(tab.id, { active: true });
  void chrome.windows.update(tab.windowId, { focused: true });
  if (!isPanel) window.close();
}

const MEMORY_SENTENCES: Record<Appetite["memory"], string> = {
  light: "Light on memory",
  moderate: "Moderate memory use",
  heavy: "Heavy memory use",
  "very heavy": "Very heavy memory use",
  unknown: "Memory use unknown",
};

/** One to four dots: the more filled, the hungrier the tab. */
function appetiteMeter(appetite: Appetite | null): HTMLElement | null {
  if (!appetite) return null;
  const meter = el("span", "appetite");
  meter.dataset.level = String(appetite.level);
  const summary = `${MEMORY_SENTENCES[appetite.memory]}${appetite.busy ? ", busy in the background" : ""}`;
  meter.title = summary;
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", `Hunger ${appetite.level} of 4: ${summary}`);
  for (let i = 1; i <= 4; i++) meter.append(el("span", i <= appetite.level ? "dot on" : "dot"));
  return meter;
}

function setCursor(tabId: number | null, scroll = false): void {
  cursorId = tabId;
  navRows.forEach((nav, index) => {
    const current = nav.tabId === tabId;
    nav.row.classList.toggle("cursor", current);
    if (current) {
      cursorIndex = index;
      if (scroll) nav.row.scrollIntoView({ block: "nearest" });
    }
  });
}

function row(entry: Entry, actions: RowAction[]): HTMLLIElement {
  const { tab, verdict } = entry;
  const item = el("li", verdict.protection === "asleep" ? "row asleep" : "row");

  const main = el("button", "row-main");
  main.type = "button";
  main.title = tab.title;
  main.tabIndex = -1;
  const icon = el("img");
  icon.src = faviconUrl(tab.url);
  icon.alt = "";
  const text = el("div", "text");
  text.append(el("div", "title", tab.title || tab.url), metaLine(entry));
  main.append(icon, text);
  main.addEventListener("click", () => openTab(tab));
  item.append(main);

  const meter = appetiteMeter(verdict.appetite);
  if (meter) item.append(meter);

  if (actions.length > 0) {
    const bar = el("div", "row-actions");
    for (const action of actions) {
      const button = el("button", "row-action");
      button.type = "button";
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      button.innerHTML = ICONS[action.icon];
      button.addEventListener("click", () => void runRowAction(item, action));
      bar.append(button);
    }
    item.append(bar);
  }
  item.addEventListener("mouseenter", () => setCursor(tab.id));
  navRows.push({ tabId: tab.id, row: item, tab, actions });
  return item;
}

async function runRowAction(item: HTMLElement, action: RowAction): Promise<void> {
  if (action.key === "sleep" || action.key === "close") await leave([item]);
  await act(action.run);
}

function section(
  title: string,
  entries: Entry[],
  actionsFor: (entry: Entry) => RowAction[],
  options: { collapsible?: boolean; open?: boolean; forceOpen?: boolean } = {},
): HTMLElement | null {
  if (entries.length === 0) return null;

  const container = options.collapsible ? el("details", "section") : el("section", "section");
  const heading = el(options.collapsible ? "summary" : "div", "section-title");
  const label = el("span", undefined, title);
  label.append(el("span", "count", String(entries.length)));
  heading.append(label);
  container.append(heading);

  const open =
    !(container instanceof HTMLDetailsElement) ||
    options.forceOpen === true ||
    (openSections.get(title) ?? options.open ?? false);
  const rows = el("ul", "rows");
  container.append(rows);

  if (container instanceof HTMLDetailsElement) {
    container.open = open;
    container.addEventListener("toggle", () => {
      if (options.forceOpen || container.open === open) return;
      openSections.set(title, container.open);
      if (state) renderTabs(state);
    });
  }

  // Rows inside closed sections aren't reachable by keyboard, so only build them when visible.
  if (open) for (const entry of entries) rows.append(row(entry, actionsFor(entry)));
  return container;
}

async function unkeepHost(url: string): Promise<void> {
  if (!state) return;
  const host = hostOf(url);
  await saveSettings({
    ...state.settings,
    neverSleepHosts: state.settings.neverSleepHosts.filter((p) => !matchesHost(host, p)),
  });
}

async function keepHost(url: string): Promise<void> {
  if (!state) return;
  const host = hostOf(url);
  if (!host || state.settings.neverSleepHosts.includes(host)) return;
  await saveSettings({
    ...state.settings,
    neverSleepHosts: [...state.settings.neverSleepHosts, host],
  });
}

function renderTabs(assessment: Assessment): void {
  const tabsById = new Map(assessment.tabs.map((tab) => [tab.id, tab]));
  const all: Entry[] = assessment.verdicts.flatMap((verdict) => {
    const tab = tabsById.get(verdict.tabId);
    return tab ? [{ tab, verdict }] : [];
  });
  const query = search.value.trim().toLowerCase();
  const entries = query
    ? all.filter(
        (e) => e.tab.title.toLowerCase().includes(query) || e.tab.url.toLowerCase().includes(query),
      )
    : all;
  const byScore = (a: Entry, b: Entry): number => b.verdict.score - a.verdict.score;
  const isDuplicate = (e: Entry): boolean =>
    e.verdict.duplicateOf !== null && e.verdict.protection !== "active";

  const duplicates = entries.filter(isDuplicate);
  const unique = entries.filter((e) => !isDuplicate(e));
  const suggested = unique.filter((e) => e.verdict.suggested).sort(byScore);
  const awake = unique
    .filter((e) => e.verdict.protection === null && !e.verdict.suggested)
    .sort(byScore);
  const kept = unique.filter(
    (e) => e.verdict.protection !== null && e.verdict.protection !== "asleep",
  );
  const asleep = unique
    .filter((e) => e.verdict.protection === "asleep")
    .sort((a, b) => b.tab.lastAccessed - a.tab.lastAccessed);

  const suggestedCount = assessment.verdicts.filter((v) => v.suggested).length;
  const duplicateCount = all.filter(isDuplicate).length;
  sleepButton.disabled = suggestedCount === 0;
  sleepButton.textContent =
    suggestedCount === 0 ? "Nothing to sleep" : `Sleep ${suggestedCount} suggested`;
  dupesButton.hidden = duplicateCount === 0;
  dupesButton.textContent = `Close ${plural(duplicateCount, "duplicate")}`;

  const keepAction = (entry: Entry): RowAction => ({
    key: "keep",
    icon: "keep",
    label: "Always keep this site awake (⌘K)",
    run: () => keepHost(entry.tab.url),
  });
  const unkeepAction = (entry: Entry): RowAction => ({
    key: "unkeep",
    icon: "unkeep",
    label: "Stop keeping this site awake (⌘K)",
    run: () => unkeepHost(entry.tab.url),
  });
  const sleepAction = (entry: Entry): RowAction => ({
    key: "sleep",
    icon: "sleep",
    label: "Sleep this tab (⌘S)",
    run: () => send({ type: "sleep", tabIds: [entry.tab.id] }),
  });
  const closeAction = (entry: Entry, label = "Close this tab"): RowAction => ({
    key: "close",
    icon: "close",
    label: `${label} (⌘⌫)`,
    run: () => send({ type: "close", tabIds: [entry.tab.id] }),
  });

  const sleepable = (entry: Entry): RowAction[] => [
    keepAction(entry),
    sleepAction(entry),
    closeAction(entry),
  ];
  // Kept-awake tabs only stop Doze acting on its own; you can still sleep or close them.
  const keptActions = (entry: Entry): RowAction[] => {
    switch (entry.verdict.protection) {
      case "kept":
        return [unkeepAction(entry), sleepAction(entry), closeAction(entry)];
      case "pinned":
      case "excluded":
        return [sleepAction(entry), closeAction(entry)];
      case "audible":
        return [closeAction(entry)];
      default:
        return [];
    }
  };
  const forceOpen = query !== "";

  navRows = [];
  const sections = [
    section("Ready to sleep", suggested, sleepable),
    section("Duplicates", duplicates, (entry) => [closeAction(entry, "Close this copy")]),
    section("Awake", awake, sleepable, {
      collapsible: true,
      open: suggested.length === 0,
      forceOpen,
    }),
    section("Kept awake", kept, keptActions, { collapsible: true, forceOpen }),
    section("Asleep", asleep, (entry) => [closeAction(entry)], { collapsible: true, forceOpen }),
  ].filter((node): node is HTMLElement => node !== null);

  lists.replaceChildren(...sections);
  if (sections.length === 0) {
    lists.append(
      el("p", "empty", query ? `No tabs match “${search.value.trim()}”.` : "No tabs to show."),
    );
  }

  const keep = navRows.find((nav) => nav.tabId === cursorId);
  const fallback = navRows[Math.min(cursorIndex, navRows.length - 1)];
  setCursor(keep?.tabId ?? fallback?.tabId ?? null);
}

// ---------- activity view ----------

function renderActivity(): void {
  const week = totalsSince(activity, Date.now() - WEEK_MS);
  const card = el("div", "summary-card");
  card.append(
    el("p", "big", week.bytes > 0 ? `About ${formatBytes(week.bytes)} freed` : "Nothing freed yet"),
    el(
      "p",
      "small",
      `This week: ${plural(week.slept, "tab")} slept, ${plural(week.closed, "tab")} closed.`,
    ),
  );

  const events = el("ul", "rows");
  const now = Date.now();
  for (const entry of activity.slice(0, 60)) {
    const item = el("li", entry.undone ? "event undone" : "event");
    const icon = el("span", "event-icon");
    icon.innerHTML =
      ICONS[entry.kind === "learned" ? "learned" : entry.kind === "close" ? "close" : "sleep"];

    const text = el("div", "text");
    const parts = [
      entry.kind === "learned" ? "Learned" : SOURCE_LABELS[entry.source],
      ago(entry.at),
    ];
    if (entry.undone) parts.push("Undone");
    else if (entry.measuring) parts.push("measuring…");
    else if (entry.freedBytes) parts.push(`freed about ${formatBytes(entry.freedBytes)}`);
    text.append(el("div", "title", describe(entry)), el("div", "meta", parts.join(" · ")));
    item.append(icon, text);

    if (canUndo(entry, now)) {
      const undo = el("button", "link", entry.kind === "learned" ? "Forget" : "Undo");
      undo.type = "button";
      undo.addEventListener(
        "click",
        () => void act(() => send({ type: "undo", entryId: entry.id })),
      );
      item.append(undo);
    }
    events.append(item);
  }

  activityView.replaceChildren(card);
  activityView.append(
    activity.length === 0
      ? el("p", "empty", "When Doze sleeps or closes tabs, it shows up here with an undo.")
      : events,
  );
}

// ---------- settings ----------

function renderSettings(assessment: Assessment): void {
  const { settings } = assessment;
  autoSleep.value = String(settings.autoSleepMinutes);
  protectPinned.checked = settings.protectPinned;
  openInPanel.checked = settings.openInPanel;

  keptHosts.replaceChildren();
  if (settings.neverSleepHosts.length === 0) {
    keptHosts.append(el("li", "none", "None yet. Use the shield on a tab to add its site."));
  }
  for (const host of settings.neverSleepHosts) {
    const chip = el("li", "chip", host);
    const remove = el("button", undefined, "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Stop keeping ${host} awake`);
    remove.addEventListener("click", () =>
      void act(() =>
        saveSettings({
          ...settings,
          neverSleepHosts: settings.neverSleepHosts.filter((h) => h !== host),
        }),
      ),
    );
    chip.append(remove);
    keptHosts.append(chip);
  }
}

// ---------- hunger meter ----------

async function renderHunger(): Promise<void> {
  const [on, { hungerOfferDismissed }] = await Promise.all([
    hungerEnabled(),
    chrome.storage.local.get("hungerOfferDismissed"),
  ]);
  hungerToggle.checked = on;
  hungerOffer.hidden = on || Boolean(hungerOfferDismissed);
}

/** Asks Chrome for page access; the worker sets up the probes once it's granted. */
async function turnOnHunger(): Promise<void> {
  const granted = await requestHunger();
  await renderHunger();
  // Give the freshly injected probes a moment to answer before redrawing.
  if (granted) setTimeout(() => void render(), 1000);
}

// ---------- render ----------

async function render(): Promise<void> {
  [state, activity] = await Promise.all([currentAssessment(), loadActivity()]);
  renderInsight();
  renderToast();
  renderTabs(state);
  renderActivity();
  renderSettings(state);
}

function selectView(next: typeof view): void {
  view = next;
  for (const tab of viewTabs) tab.setAttribute("aria-selected", String(tab.dataset.view === next));
  showSettings(false);
}

/** Settings take the list's place, so the popup never grows past Chrome's height limit. */
function showSettings(show: boolean): void {
  settingsPanel.hidden = !show;
  settingsToggle.setAttribute("aria-expanded", String(show));
  settingsToggle.textContent = show ? "Done" : "Settings";
  lists.hidden = show || view !== "tabs";
  activityView.hidden = show || view !== "activity";
}

function moveCursor(delta: number): void {
  if (navRows.length === 0) return;
  const index = navRows.findIndex((nav) => nav.tabId === cursorId);
  const next = Math.min(navRows.length - 1, Math.max(0, index + delta));
  setCursor(navRows[next]?.tabId ?? null, true);
}

// ---------- events ----------

sleepButton.addEventListener("click", () => {
  const suggestedRows = [...lists.querySelectorAll<HTMLElement>(".section:first-child .row")];
  void leave(suggestedRows).then(() => act(() => send({ type: "sleep-suggested" })));
});

dupesButton.addEventListener("click", () => void act(() => send({ type: "close-duplicates" })));

search.addEventListener("input", () => {
  cursorIndex = 0;
  cursorId = null;
  if (view !== "tabs") selectView("tabs");
  if (state) renderTabs(state);
});

for (const tab of viewTabs) {
  tab.addEventListener("click", () =>
    selectView(tab.dataset.view === "activity" ? "activity" : "tabs"),
  );
}

settingsToggle.addEventListener("click", () =>
  showSettings(settingsToggle.getAttribute("aria-expanded") !== "true"),
);

openInPanel.addEventListener("change", () => {
  if (!state) return;
  const settings = state.settings;
  void act(() => saveSettings({ ...settings, openInPanel: openInPanel.checked }));
});

autoSleep.addEventListener("change", () => {
  if (!state) return;
  const settings = state.settings;
  void act(() => saveSettings({ ...settings, autoSleepMinutes: Number(autoSleep.value) }));
});

protectPinned.addEventListener("change", () => {
  if (!state) return;
  const settings = state.settings;
  void act(() => saveSettings({ ...settings, protectPinned: protectPinned.checked }));
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const inOtherField =
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && target !== search);
  if (inOtherField || view !== "tabs") return;

  const mod = event.metaKey || event.ctrlKey;
  const current = navRows.find((nav) => nav.tabId === cursorId);
  const runKey = (key: ActionKey): void => {
    const action = current?.actions.find((a) => a.key === key);
    if (current && action) void runRowAction(current.row, action);
  };

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveCursor(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && (target === search || target === document.body)) {
    event.preventDefault();
    if (current) openTab(current.tab);
  } else if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    runKey("sleep");
  } else if (mod && event.key === "Backspace") {
    event.preventDefault();
    runKey("close");
  } else if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    runKey(current?.actions.some((a) => a.key === "unkeep") ? "unkeep" : "keep");
  } else if (event.key === "Escape" && search.value) {
    event.preventDefault();
    search.value = "";
    search.dispatchEvent(new Event("input"));
  }
});

// The background worker finishes measuring a couple of seconds after an action.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.activity) return;
  activity = (changes.activity.newValue as ActivityEntry[] | undefined) ?? [];
  renderToast();
  renderInsight();
  renderActivity();
});

hungerOn.addEventListener("click", () => void turnOnHunger());

hungerLater.addEventListener("click", () => {
  hungerOffer.hidden = true;
  void chrome.storage.local.set({ hungerOfferDismissed: true });
});

hungerToggle.addEventListener("change", () => {
  if (hungerToggle.checked) void turnOnHunger();
  else void turnOffHunger().then(renderHunger).then(render);
});

// sidePanel.open needs the click's user gesture, so the window id is looked up ahead of time.
void chrome.windows.getCurrent().then((win) => (windowId = win.id));
openPanel.hidden = isPanel;
openPanel.addEventListener("click", () => {
  if (windowId === undefined) return;
  void chrome.sidePanel.open({ windowId });
  window.close();
});

if (isPanel) {
  // The panel stays open, so keep it in step with the browser.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void render(), 400);
  };
  chrome.tabs.onUpdated.addListener(refresh);
  chrome.tabs.onCreated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onActivated.addListener(refresh);
  setInterval(refresh, 30_000);
}

search.focus();
void renderHunger();
void render();
void updateVitals();
setTimeout(() => void updateVitals(), 800);
setInterval(() => void updateVitals(), 2000);

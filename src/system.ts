// Whole-machine memory and CPU readings. Chrome doesn't expose per-tab memory to extensions,
// so these are the only resource numbers Doze can show truthfully.

export type Pressure = "calm" | "busy" | "strained";

export interface Vitals {
  capacity: number;
  available: number;
  /** 0–1 share of CPU time in use across all cores, or null until two samples exist. */
  cpu: number | null;
}

export interface CpuSample {
  idle: number;
  total: number;
}

const MEMORY_BUSY = 0.25;
const MEMORY_STRAINED = 0.12;
const CPU_BUSY = 0.6;
const CPU_STRAINED = 0.85;

export function cpuSample(info: { processors: { usage: CpuSample }[] }): CpuSample {
  return info.processors.reduce(
    (sum, { usage }) => ({ idle: sum.idle + usage.idle, total: sum.total + usage.total }),
    { idle: 0, total: 0 },
  );
}

export function cpuLoad(previous: CpuSample, next: CpuSample): number | null {
  const total = next.total - previous.total;
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, 1 - (next.idle - previous.idle) / total));
}

function memoryPressure(vitals: Vitals): Pressure {
  const free = vitals.available / vitals.capacity;
  if (free < MEMORY_STRAINED) return "strained";
  if (free < MEMORY_BUSY) return "busy";
  return "calm";
}

function cpuPressure(vitals: Vitals): Pressure {
  if (vitals.cpu === null) return "calm";
  if (vitals.cpu >= CPU_STRAINED) return "strained";
  if (vitals.cpu >= CPU_BUSY) return "busy";
  return "calm";
}

const RANK: Record<Pressure, number> = { calm: 0, busy: 1, strained: 2 };

export function pressureOf(vitals: Vitals): Pressure {
  const memory = memoryPressure(vitals);
  const cpu = cpuPressure(vitals);
  return RANK[cpu] > RANK[memory] ? cpu : memory;
}

export function headline(vitals: Vitals): string {
  const memory = memoryPressure(vitals);
  const cpu = cpuPressure(vitals);
  if (memory === "strained") return "Your Mac is low on memory";
  if (cpu === "strained") return "Your Mac is working very hard";
  if (memory === "busy") return "Memory is getting tight";
  if (cpu === "busy") return "Your Mac is busy";
  return "Everything is running smoothly";
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export async function readMemory(): Promise<{ capacity: number; available: number }> {
  const { capacity, availableCapacity } = await chrome.system.memory.getInfo();
  return { capacity, available: availableCapacity };
}

export async function readCpu(): Promise<CpuSample> {
  return cpuSample(await chrome.system.cpu.getInfo());
}

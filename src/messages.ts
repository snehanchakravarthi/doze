// Popup → background requests. Actions run in the worker so logging and measuring survive the
// popup closing.

export type Request =
  | { type: "sleep"; tabIds: number[] }
  | { type: "sleep-suggested" }
  | { type: "close"; tabIds: number[] }
  | { type: "close-duplicates" }
  | { type: "undo"; entryId: string };

export async function send(request: Request): Promise<void> {
  await chrome.runtime.sendMessage(request);
}

import { setTimeout as nodeDelay } from "node:timers/promises";

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await nodeDelay(ms, undefined, { signal });
}

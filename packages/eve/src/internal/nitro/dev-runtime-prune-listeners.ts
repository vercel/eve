import { resolve } from "node:path";

const listeners = new Map<string, Set<() => Promise<void>>>();

export function onDevelopmentRuntimePruned(
  appRoot: string,
  listener: () => Promise<void>,
): () => void {
  const key = resolve(appRoot);
  const registered = listeners.get(key) ?? new Set();
  registered.add(listener);
  listeners.set(key, registered);
  return () => {
    registered.delete(listener);
    if (registered.size === 0 && listeners.get(key) === registered) listeners.delete(key);
  };
}

export async function notifyDevelopmentRuntimePruned(appRoot: string): Promise<void> {
  for (const listener of listeners.get(resolve(appRoot)) ?? []) {
    await listener();
  }
}

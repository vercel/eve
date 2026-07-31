import { loadContext, type AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

/**
 * Runs a callback with one invocation-scoped value in eve's unified context.
 */
export async function withVirtualContextValue<T, Value>(
  key: ContextKey<Value>,
  value: Value,
  callback: () => T | Promise<T>,
): Promise<T> {
  return await runWithValue(loadContext(), key, value, callback);
}

async function runWithValue<T, Value>(
  context: AlsContext,
  key: ContextKey<Value>,
  value: Value,
  callback: () => T | Promise<T>,
): Promise<T> {
  const hadPrevious = context.has(key);
  const previous = context.get(key);
  context.setVirtualContext(key, value);
  try {
    return await callback();
  } finally {
    if (hadPrevious) {
      context.setVirtualContext(key, previous as Value);
    } else {
      context.deleteVirtualContext(key);
    }
  }
}

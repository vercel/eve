import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import {
  getActiveRuntimeSession,
  type RuntimeConnectionRegistryCacheEntry,
} from "#runtime/sessions/runtime-session.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

export const CONNECTION_REGISTRY_CACHE_MAX_SESSIONS = 256;

/**
 * Returns the live connection registry for one durable session and callback
 * scope. Distinct scopes remain live until terminal cleanup so concurrent turns
 * cannot close each other's clients.
 */
export function getSessionConnectionRegistry(input: {
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly scopeKey: string;
  readonly sessionId: string;
}): ConnectionRegistry {
  if (input.sessionId.length === 0) {
    return new ConnectionRegistryImpl(input.connections);
  }

  const runtimeSession = getActiveRuntimeSession();
  const cache = (runtimeSession.connectionRegistryCache ??= new Map<
    string,
    readonly RuntimeConnectionRegistryCacheEntry[]
  >());
  const sessionEntries = cache.get(input.sessionId) ?? [];
  const cached = sessionEntries.find(
    (entry) => entry.connections === input.connections && entry.scopeKey === input.scopeKey,
  );
  if (cached !== undefined) {
    touchSession(cache, input.sessionId, sessionEntries);
    return cached.registry;
  }

  const registry = new ConnectionRegistryImpl(input.connections);
  touchSession(cache, input.sessionId, [
    ...sessionEntries,
    {
      connections: input.connections,
      registry,
      scopeKey: input.scopeKey,
    },
  ]);
  evictOverflowSessions(cache);
  return registry;
}

/** Closes and removes the process-local registry for a terminal session. */
export async function disposeSessionConnectionRegistry(sessionId: string): Promise<void> {
  if (sessionId.length === 0) return;

  const cache = getActiveRuntimeSession().connectionRegistryCache;
  const sessionEntries = cache?.get(sessionId);
  if (cache === undefined || sessionEntries === undefined) return;

  cache.delete(sessionId);
  await disposeRegistryEntries(sessionEntries);
}

function touchSession(
  cache: NonNullable<ReturnType<typeof getActiveRuntimeSession>["connectionRegistryCache"]>,
  sessionId: string,
  entries: readonly RuntimeConnectionRegistryCacheEntry[],
): void {
  cache.delete(sessionId);
  cache.set(sessionId, entries);
}

function evictOverflowSessions(
  cache: NonNullable<ReturnType<typeof getActiveRuntimeSession>["connectionRegistryCache"]>,
): void {
  while (cache.size > CONNECTION_REGISTRY_CACHE_MAX_SESSIONS) {
    const oldestSessionId = cache.keys().next().value;
    if (oldestSessionId === undefined) return;

    const entries = cache.get(oldestSessionId);
    cache.delete(oldestSessionId);
    if (entries !== undefined) {
      void disposeRegistryEntries(entries);
    }
  }
}

async function disposeRegistryEntries(
  entries: readonly RuntimeConnectionRegistryCacheEntry[],
): Promise<void> {
  await Promise.allSettled(entries.map(async ({ registry }) => await registry.dispose()));
}

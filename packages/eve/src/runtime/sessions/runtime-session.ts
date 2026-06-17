import { AsyncLocalStorage } from "node:async_hooks";

import type { BundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * Process-scoped container for mutable runtime state owned by one eve
 * deployment.
 *
 * Holds installed compiled artifacts and compiled-agent bundle caches.
 * Tests use {@link withRuntimeSession} to avoid mutating the process
 * default session.
 */
export interface RuntimeSession {
  /**
   * Diagnostic identifier (e.g. `"process-default"` or a test-provided label).
   * Used for logs and error messages; not relied on for dispatch.
   */
  readonly id: string;
  /**
   * The installed bundled compiled-artifact snapshot, or `null` when no
   * snapshot has been installed in this session yet.
   */
  compiledArtifacts: BundledCompiledArtifacts | null;
  /**
   * Cache of resolved compiled-agent bundles, keyed by the versioned cache key
   * derived from the compiled-artifact source.
   */
  readonly bundleCache: Map<string, Promise<CompiledRuntimeAgentBundle>>;
  /**
   * Reverse index from the stable source key to the currently active versioned
   * cache key. Used to evict the previous entry when a source's version
   * changes.
   */
  readonly bundleCacheKeyBySourceKey: Map<string, string>;
}

/**
 * Creates a fresh, empty runtime session.
 */
export function createRuntimeSession(id: string = "test-session"): RuntimeSession {
  return {
    bundleCache: new Map(),
    bundleCacheKeyBySourceKey: new Map(),
    compiledArtifacts: null,
    id,
  };
}

/**
 * Process-global storage for the current `RuntimeSession`.
 *
 * Rooted on `globalThis` so Nitro-inlined eve and disk-imported eve share
 * the same process default while tests still get async-scoped overrides.
 */
const RUNTIME_SESSION_STORAGE_GLOBAL_KEY = Symbol.for("eve.runtime-session-storage");
const RUNTIME_SESSION_DEFAULT_GLOBAL_KEY = Symbol.for("eve.runtime-session-default");

interface RuntimeSessionGlobal {
  [RUNTIME_SESSION_STORAGE_GLOBAL_KEY]?: AsyncLocalStorage<RuntimeSession>;
  [RUNTIME_SESSION_DEFAULT_GLOBAL_KEY]?: RuntimeSession;
}

const globalContainer = globalThis as typeof globalThis & RuntimeSessionGlobal;

if (globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY] === undefined) {
  globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY] = new AsyncLocalStorage<RuntimeSession>();
}

const runtimeSessionStorage = globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY];

function resolveProcessDefaultSession(): RuntimeSession {
  if (globalContainer[RUNTIME_SESSION_DEFAULT_GLOBAL_KEY] === undefined) {
    globalContainer[RUNTIME_SESSION_DEFAULT_GLOBAL_KEY] = createRuntimeSession("process-default");
  }
  return globalContainer[RUNTIME_SESSION_DEFAULT_GLOBAL_KEY];
}

/**
 * Returns the runtime session that should be consulted for the current call.
 *
 * Returns the scoped session when {@link withRuntimeSession} is active in
 * the current async context, otherwise the process-default session
 * (lazily created on first access).
 */
export function getActiveRuntimeSession(): RuntimeSession {
  return runtimeSessionStorage.getStore() ?? resolveProcessDefaultSession();
}

/**
 * Executes `fn` with `session` installed as the active runtime session for
 * the duration of the callback, including across every `await` boundary
 * inside it. Concurrent callers each observe their own session. The
 * process-default session is untouched.
 */
export async function withRuntimeSession<T>(
  session: RuntimeSession,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await runtimeSessionStorage.run(session, async () => await fn());
}

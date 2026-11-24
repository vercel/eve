import type { DescribedAgent } from "#channel/agent-description.js";
import type { InstalledSkillFiles } from "#channel/skill-files.js";
import type { BundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { eveRuntime } from "#runtime/eve-runtime.js";
import { createScopeStorage, type ScopeStorage } from "#context/scope-storage.js";

export interface RuntimeSession {
  readonly id: string;
  compiledArtifacts: BundledCompiledArtifacts | null;
  readonly bundleCache: Map<string, Promise<CompiledRuntimeAgentBundle>>;
  readonly bundleCacheKeyBySourceKey: Map<string, string>;
  readonly describedAgents: Map<
    string,
    { readonly agent: Promise<DescribedAgent>; readonly version: string }
  >;
  skillFiles: InstalledSkillFiles | null;
}

export function createRuntimeSession(id: string = "test-session"): RuntimeSession {
  return {
    bundleCache: new Map(),
    bundleCacheKeyBySourceKey: new Map(),
    compiledArtifacts: null,
    describedAgents: new Map(),
    id,
    skillFiles: null,
  };
}

export function setRuntimeSessionCompiledArtifacts(
  session: RuntimeSession,
  input: BundledCompiledArtifacts,
): void {
  const installed = session.compiledArtifacts;
  const snapshotChanged = installed === null || !isSameCompiledArtifactSnapshot(installed, input);

  if (snapshotChanged) {
    session.bundleCache.clear();
    session.bundleCacheKeyBySourceKey.clear();
    session.describedAgents.clear();
  }

  session.compiledArtifacts = input;
}

function isSameCompiledArtifactSnapshot(
  installed: BundledCompiledArtifacts,
  input: BundledCompiledArtifacts,
): boolean {
  const installedSourceGraphHash = installed.metadata?.discovery.sourceGraphHash;
  const inputSourceGraphHash = input.metadata?.discovery.sourceGraphHash;

  if (installedSourceGraphHash && inputSourceGraphHash) {
    return (
      installedSourceGraphHash === inputSourceGraphHash &&
      JSON.stringify(installed.sandboxPreparedArtifacts) ===
        JSON.stringify(input.sandboxPreparedArtifacts)
    );
  }

  return (
    installed.manifest === input.manifest &&
    installed.moduleMap === input.moduleMap &&
    installed.metadata === input.metadata
  );
}

const RUNTIME_SESSION_STORAGE_GLOBAL_KEY = Symbol.for("eve.runtime-session-storage");

interface RuntimeSessionGlobal {
  [RUNTIME_SESSION_STORAGE_GLOBAL_KEY]?: ScopeStorage<RuntimeSession>;
}

const globalContainer = globalThis as typeof globalThis & RuntimeSessionGlobal;

if (globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY] === undefined) {
  globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY] =
    createScopeStorage<RuntimeSession>("runtime session");
}

const runtimeSessionStorage = globalContainer[RUNTIME_SESSION_STORAGE_GLOBAL_KEY];

function resolveProcessDefaultSession(): RuntimeSession {
  const runtime = eveRuntime();
  return (runtime.defaultSession ??= createRuntimeSession("process-default"));
}

export function getActiveRuntimeSession(): RuntimeSession {
  return runtimeSessionStorage.getStore() ?? resolveProcessDefaultSession();
}

export async function withRuntimeSession<T>(
  session: RuntimeSession,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await runtimeSessionStorage.run(session, async () => await fn());
}

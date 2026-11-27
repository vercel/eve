import {
  getCompiledRuntimeAgentBundle,
  type CompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import {
  createRuntimeSession,
  withRuntimeSession,
  type RuntimeSession,
} from "#runtime/sessions/runtime-session.js";

export interface WorkspaceSnapshotRef {
  readonly workspaceId: string;
  readonly versionHash: string;
  /** Directory that contains `.eve/compile/*` for this exact version. */
  readonly appRoot: string;
  /** Environment the compiled module map reads while it evaluates (for example HUB_WORKSPACE). */
  readonly env?: Readonly<Record<string, string>>;
}

export type WorkspaceSnapshotKey = `${string}@${string}`;

const sessions = new Map<WorkspaceSnapshotKey, RuntimeSession>();
let loadQueue: Promise<unknown> = Promise.resolve();

export function workspaceSnapshotKey(ref: Pick<WorkspaceSnapshotRef, "workspaceId" | "versionHash">) {
  return `${ref.workspaceId}@${ref.versionHash}` as const;
}

/**
 * Loads (or returns the cached) compiled agent bundle of one workspace version.
 * Each `workspaceId@versionHash` owns a RuntimeSession, so versions never share a bundle cache
 * and a version can be dropped as a unit.
 */
export async function loadWorkspaceBundle(
  ref: WorkspaceSnapshotRef,
): Promise<CompiledRuntimeAgentBundle> {
  const key = workspaceSnapshotKey(ref);
  let session = sessions.get(key);
  if (session === undefined) {
    session = createRuntimeSession(key);
    sessions.set(key, session);
  }
  const owned = session;
  const load = async () => {
    const previous = applyEnv(ref.env);
    try {
      return await withRuntimeSession(owned, () =>
        getCompiledRuntimeAgentBundle({
          compiledArtifactsSource: { kind: "disk", appRoot: ref.appRoot },
        }),
      );
    } finally {
      restoreEnv(previous);
    }
  };
  // Module maps read process.env while they evaluate, so loads that set env run one at a time.
  const result = loadQueue.then(load, load);
  loadQueue = result.catch(() => undefined);
  try {
    return await result;
  } catch (error) {
    if (sessions.get(key) === owned) sessions.delete(key);
    throw error;
  }
}

export function evictWorkspaceBundle(
  ref: Pick<WorkspaceSnapshotRef, "workspaceId" | "versionHash">,
): boolean {
  return sessions.delete(workspaceSnapshotKey(ref));
}

export function listLoadedWorkspaceBundles(): WorkspaceSnapshotKey[] {
  return [...sessions.keys()];
}

function applyEnv(env: WorkspaceSnapshotRef["env"]): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env ?? {})) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return previous;
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

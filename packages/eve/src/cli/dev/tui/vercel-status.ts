import { detectProjectIdentity, type ProjectIdentity } from "#setup/project-resolution.js";

/** Workspace-scoped Vercel state shown in the dev TUI's status line. */
export interface VercelStatusSnapshot {
  /** Resolved link identity; absent while unlinked or while a probe is in flight. */
  identity?: ProjectIdentity;
  /** A /channels run added ≥1 channel this session and no /deploy has shipped since. */
  pendingDeploy: boolean;
}

/**
 * Status-line effect a completed setup command reports back to the runner.
 * Session-scoped by design: a deploy from another terminal or channels added
 * before this session escape it — accepted v1 limits.
 */
export type VercelStatusEffect =
  | { kind: "channels-added" }
  | { kind: "deployed" }
  | { kind: "refresh-identity" };

export interface VercelStatusTrackerOptions {
  /** Absolute local application root holding the `.vercel` link directory. */
  appRoot: string;
  /** Receives every snapshot change, including async identity resolutions. */
  onChange: (snapshot: VercelStatusSnapshot) => void;
  /** Test seam; defaults to the real network-bound probe. */
  detectIdentity?: typeof detectProjectIdentity;
}

/**
 * Owns the Vercel segment of the dev TUI status line: one cached link
 * identity and the session-scoped pending-deploy flag. The identity probe is
 * network-bound (it shells `vercel api`), so it runs only at startup and
 * after provider setup or a /deploy — never on a poll. A linked directory
 * whose `vercel` CLI call fails resolves to the raw project id as the name
 * (see {@link detectProjectIdentity}); an unlinked one resolves to no identity,
 * which hides the segment.
 */
export interface VercelStatusTracker {
  /** Fire-and-forget identity re-probe; stale resolutions are discarded. */
  refreshIdentity(): void;
  applyEffect(effect: VercelStatusEffect): void;
  current(): VercelStatusSnapshot;
  /** Stops future onChange emissions; in-flight probe results are dropped. */
  dispose(): void;
}

/** Creates the {@link VercelStatusTracker} for one dev TUI session. */
export function createVercelStatusTracker(
  options: VercelStatusTrackerOptions,
): VercelStatusTracker {
  const detectIdentity = options.detectIdentity ?? detectProjectIdentity;
  let identity: ProjectIdentity | undefined;
  let pendingDeploy = false;
  // Incremented on every refresh and on dispose, so a slow probe that loses
  // the race (e.g. startup probe vs. a /vercel re-link's probe) can never
  // overwrite the newer result.
  let epoch = 0;
  let disposed = false;

  const snapshot = (): VercelStatusSnapshot => {
    const current: VercelStatusSnapshot = { pendingDeploy };
    if (identity !== undefined) current.identity = identity;
    return current;
  };

  const emit = (): void => {
    if (disposed) return;
    options.onChange(snapshot());
  };

  const refreshIdentity = (): void => {
    epoch += 1;
    const probeEpoch = epoch;
    void (async () => {
      let resolved: ProjectIdentity | undefined;
      try {
        resolved = await detectIdentity(options.appRoot);
      } catch {
        // detectProjectIdentity never throws today; if a future change does,
        // keep the last known identity rather than killing the prompt loop.
        return;
      }
      if (disposed || probeEpoch !== epoch) return;
      identity = resolved;
      emit();
    })();
  };

  return {
    refreshIdentity,
    applyEffect(effect) {
      switch (effect.kind) {
        case "channels-added":
          pendingDeploy = true;
          emit();
          return;
        case "deployed":
          pendingDeploy = false;
          emit();
          // A deploy can create the link (the flow walks the pickers when
          // unlinked), so the identity may have just come into existence.
          refreshIdentity();
          return;
        case "refresh-identity":
          refreshIdentity();
          return;
      }
    },
    current: snapshot,
    dispose() {
      disposed = true;
      epoch += 1;
    },
  };
}

import { resolveModelTeamSlug } from "#internal/model-auth/vercel-team.js";
import { detectProjectIdentity, type ProjectIdentity } from "#setup/project-resolution.js";

/** Workspace-scoped Vercel state shown in the dev TUI's status line. */
export interface VercelStatusSnapshot {
  /** Resolved link identity; absent while unlinked or while a probe is in flight. */
  identity?: ProjectIdentity;
  modelTeamSlug?: string;
}

/**
 * Status-line effect a completed setup command reports back to the runner.
 * Session-scoped by design: a deploy from another terminal or channels added
 * before this session escape it — accepted v1 limits.
 */
export type VercelStatusEffect = { kind: "deployed" } | { kind: "refresh-identity" };

export interface VercelStatusTrackerOptions {
  /** Absolute local application root holding the `.vercel` link directory. */
  appRoot: string;
  /** Receives every snapshot change, including async identity resolutions. */
  onChange: (snapshot: VercelStatusSnapshot) => void;
  /** Test seam; defaults to the real network-bound probe. */
  detectIdentity?: typeof detectProjectIdentity;
  resolveTeamSlug?: typeof resolveModelTeamSlug;
}

/**
 * Owns the Vercel segment of the dev TUI status line: cached deployment identity and model-account team slug. The identity probe is network-bound (it shells `vercel api`), so it runs only at startup and
 * after provider setup or a /deploy — never on a poll. A linked directory
 * whose `vercel` CLI call fails resolves to the raw project id as the name
 * (see {@link detectProjectIdentity}); an unlinked one resolves to no identity,
 * which hides the segment.
 */
export interface VercelStatusTracker {
  /** Fire-and-forget identity re-probe; superseded probes are aborted. */
  refreshIdentity(): void;
  applyEffect(effect: VercelStatusEffect): void;
  current(): VercelStatusSnapshot;
  /** Stops future changes and aborts the in-flight identity probe. */
  dispose(): void;
}

/** Creates the {@link VercelStatusTracker} for one dev TUI session. */
export function createVercelStatusTracker(
  options: VercelStatusTrackerOptions,
): VercelStatusTracker {
  const detectIdentity = options.detectIdentity ?? detectProjectIdentity;
  let identity: ProjectIdentity | undefined;
  let modelTeamSlug: string | undefined;
  // Incremented on every refresh and on dispose, so a slow probe that loses
  // the race (e.g. startup probe vs. a /login refresh) can never
  // overwrite the newer result.
  let epoch = 0;
  let disposed = false;
  let identityProbeAbort: AbortController | undefined;

  const snapshot = (): VercelStatusSnapshot => {
    const value: VercelStatusSnapshot = {};
    if (identity !== undefined) value.identity = identity;
    if (modelTeamSlug !== undefined) value.modelTeamSlug = modelTeamSlug;
    return value;
  };

  const emit = (): void => {
    if (disposed) return;
    options.onChange(snapshot());
  };

  const refreshIdentity = (): void => {
    if (disposed) return;
    identityProbeAbort?.abort();
    const probeAbort = new AbortController();
    identityProbeAbort = probeAbort;
    epoch += 1;
    const probeEpoch = epoch;
    void (async () => {
      let resolved: ProjectIdentity | undefined;
      let slug: string | undefined;
      try {
        [resolved, slug] = await Promise.all([
          detectIdentity(options.appRoot, { signal: probeAbort.signal }),
          (options.resolveTeamSlug ?? resolveModelTeamSlug)(probeAbort.signal).catch(
            () => undefined,
          ),
        ]);
      } catch {
        // detectProjectIdentity never throws today; if a future change does,
        // keep the last known identity rather than killing the prompt loop.
        return;
      } finally {
        if (identityProbeAbort === probeAbort) {
          identityProbeAbort = undefined;
        }
      }
      if (disposed || probeEpoch !== epoch) return;
      identity = resolved;
      modelTeamSlug = slug;
      emit();
    })();
  };

  return {
    refreshIdentity,
    applyEffect(effect) {
      if (disposed) return;
      switch (effect.kind) {
        case "deployed":
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
      if (disposed) return;
      disposed = true;
      epoch += 1;
      identityProbeAbort?.abort();
      identityProbeAbort = undefined;
    },
  };
}

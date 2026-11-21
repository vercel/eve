import { resolveModelTeamSlug } from "#platform/vercel/model-auth/team.js";
import { detectProjectIdentity, type ProjectIdentity } from "#setup/project-resolution.js";

export interface VercelStatusSnapshot {
  identity?: ProjectIdentity;
  modelTeamSlug?: string;
}

export type VercelStatusEffect = { kind: "deployed" } | { kind: "refresh-identity" };

export interface VercelStatusTrackerOptions {
  appRoot: string;
  onChange: (snapshot: VercelStatusSnapshot) => void;
  detectIdentity?: typeof detectProjectIdentity;
  resolveTeamSlug?: typeof resolveModelTeamSlug;
}

export interface VercelStatusTracker {
  refreshIdentity(): void;
  applyEffect(effect: VercelStatusEffect): void;
  current(): VercelStatusSnapshot;
  dispose(): void;
}

export function createVercelStatusTracker(
  options: VercelStatusTrackerOptions,
): VercelStatusTracker {
  const detectIdentity = options.detectIdentity ?? detectProjectIdentity;
  let identity: ProjectIdentity | undefined;
  let modelTeamSlug: string | undefined;
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

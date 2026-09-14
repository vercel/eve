import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import type { ActivityBatchV1, ActivitySnapshotV1 } from "#protocol/activity.js";
import {
  disposeSessionActivityStep,
  renderSessionActivityStep,
} from "#execution/session-activity-renderer-step.js";

const RENDER_DEBOUNCE_MS = 350;

export interface ActivityCollectorInput {
  readonly expiresAt: string;
  readonly periodicRefreshIntervalMs?: number;
  readonly serializedContext: Record<string, unknown>;
  readonly token: string;
}

/** Independently owns activity reduction and provider presentation for one root session. */
export async function activityCollectorWorkflow(input: ActivityCollectorInput): Promise<void> {
  "use workflow";

  const batches = createHook<ActivityBatchV1>({ token: input.token });
  const iterator = batches[Symbol.asyncIterator]();
  let pendingRead: Promise<IteratorResult<ActivityBatchV1>> | undefined;
  const expiry = sleep(new Date(input.expiresAt)).then(() => ({ kind: "expired" as const }));
  let snapshot = createActivitySnapshot();
  let rendererStates: Readonly<Record<string, unknown>> = {};
  let periodicRefresh: Promise<{ readonly kind: "refresh" }> | undefined;

  try {
    await claimHookOwnership(batches);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }

  try {
    while (true) {
      pendingRead ??= iterator.next();
      const next = await Promise.race([
        pendingRead.then((value) => ({ kind: "batch" as const, value })),
        ...(periodicRefresh === undefined ? [] : [periodicRefresh]),
        expiry,
      ]);
      if (next.kind === "expired") break;
      if (next.kind === "refresh") {
        periodicRefresh = undefined;
        if (hasActiveActivity(snapshot)) {
          const rendered = await renderSessionActivityStep({
            rendererStates,
            serializedContext: input.serializedContext,
            snapshot,
          });
          rendererStates = rendered.rendererStates;
          periodicRefresh = createPeriodicRefresh(input.periodicRefreshIntervalMs);
        }
        continue;
      }
      if (next.value.done === true) break;
      pendingRead = undefined;
      const reduced = reduceCollectorActivity(snapshot, next.value.value);
      snapshot = reduced.snapshot;
      if (!reduced.presentationChanged) continue;

      const debounce = sleep(RENDER_DEBOUNCE_MS).then(() => ({ kind: "render" as const }));
      while (true) {
        pendingRead ??= iterator.next();
        const buffered = await Promise.race([
          pendingRead.then((value) => ({ kind: "batch" as const, value })),
          debounce,
          expiry,
        ]);
        if (buffered.kind === "expired") return;
        if (buffered.kind === "render") break;
        if (buffered.value.done === true) return;
        pendingRead = undefined;
        snapshot = reduceActivityBatch(snapshot, buffered.value.value);
      }

      const rendered = await renderSessionActivityStep({
        rendererStates,
        serializedContext: input.serializedContext,
        snapshot,
      });
      rendererStates = rendered.rendererStates;
      periodicRefresh ??= hasActiveActivity(snapshot)
        ? createPeriodicRefresh(input.periodicRefreshIntervalMs)
        : undefined;
    }
  } finally {
    await disposeSessionActivityStep({
      rendererStates,
      serializedContext: input.serializedContext,
    }).catch(() => {});
  }
}

function createPeriodicRefresh(
  intervalMs: number | undefined,
): Promise<{ readonly kind: "refresh" }> | undefined {
  if (intervalMs === undefined) return undefined;
  return sleep(intervalMs).then(() => ({ kind: "refresh" as const }));
}

export function hasActiveActivity(snapshot: ActivitySnapshotV1): boolean {
  return (
    Object.values(snapshot.work).some((entry) => entry.phase === "running") ||
    Object.values(snapshot.actions).some((entry) => entry.phase === "running") ||
    Object.values(snapshot.blockers).some((entry) => entry.phase === "blocked")
  );
}

export function reduceCollectorActivity(
  snapshot: ActivitySnapshotV1,
  batch: ActivityBatchV1,
): { readonly presentationChanged: boolean; readonly snapshot: ActivitySnapshotV1 } {
  const previousRevision = snapshot.revision;
  const next = reduceActivityBatch(snapshot, batch);
  return { presentationChanged: next.revision !== previousRevision, snapshot: next };
}

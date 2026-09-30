import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import type { ActivityBatchV1, ActivitySnapshotV1 } from "#protocol/activity.js";
import { renderSessionActivityStep } from "#execution/session-activity-presenter-step.js";

/** Coalesces the batches of one burst, such as a step starting several tasks. */
const RENDER_DEBOUNCE_MS = 350;
/** Slack asks agents to update a message at most once every 3 seconds. */
const RENDER_COOLDOWN_MS = 3_000;

export interface ActivityCollectorInput {
  readonly expiresAt: string;
  readonly serializedContext: Record<string, unknown>;
  readonly token: string;
}

/**
 * Owns activity reduction and presentation for one root session. A change
 * renders after a short debounce and at most once per cooldown, always from the
 * latest snapshot, so a burst renders once and the final state is never lost.
 */
export async function activityCollectorWorkflow(input: ActivityCollectorInput): Promise<void> {
  "use workflow";

  const batches = createHook<ActivityBatchV1>({ token: input.token });
  const iterator = batches[Symbol.asyncIterator]();
  let pendingRead: Promise<IteratorResult<ActivityBatchV1>> | undefined;
  const expiry = sleep(new Date(input.expiresAt)).then(() => ({ kind: "expired" as const }));
  let snapshot = createActivitySnapshot();
  let presenterState: unknown;
  let cooldown: Promise<void> = Promise.resolve();

  try {
    await claimHookOwnership(batches);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }

  while (true) {
    pendingRead ??= iterator.next();
    const next = await Promise.race([
      pendingRead.then((value) => ({ kind: "batch" as const, value })),
      expiry,
    ]);
    if (next.kind === "expired" || next.value.done === true) return;
    pendingRead = undefined;
    const reduced = reduceCollectorActivity(snapshot, next.value.value);
    snapshot = reduced.snapshot;
    if (!reduced.presentationChanged) continue;

    const ready = Promise.all([cooldown, sleep(RENDER_DEBOUNCE_MS)]).then(() => ({
      kind: "ready" as const,
    }));
    while (true) {
      pendingRead ??= iterator.next();
      const buffered = await Promise.race([
        pendingRead.then((value) => ({ kind: "batch" as const, value })),
        ready,
        expiry,
      ]);
      if (buffered.kind === "expired") return;
      if (buffered.kind === "ready" || buffered.value.done === true) break;
      pendingRead = undefined;
      snapshot = reduceActivityBatch(snapshot, buffered.value.value);
    }

    presenterState = await renderSessionActivityStep({
      presenterState,
      serializedContext: input.serializedContext,
      snapshot,
    });
    cooldown = sleep(RENDER_COOLDOWN_MS);
  }
}

export function reduceCollectorActivity(
  snapshot: ActivitySnapshotV1,
  batch: ActivityBatchV1,
): { readonly presentationChanged: boolean; readonly snapshot: ActivitySnapshotV1 } {
  const previousRevision = snapshot.revision;
  const next = reduceActivityBatch(snapshot, batch);
  return { presentationChanged: next.revision !== previousRevision, snapshot: next };
}

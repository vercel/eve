import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import type { ActivityBatchV1 } from "#protocol/activity.js";
import {
  disposeSessionActivityStep,
  renderSessionActivityStep,
} from "#execution/session-activity-renderer-step.js";

const RENDER_DEBOUNCE_MS = 350;

export interface ActivityCollectorInput {
  readonly expiresAt: string;
  readonly serializedContext: Record<string, unknown>;
  readonly token: string;
}

/** Independently owns activity reduction and provider presentation for one root session. */
export async function activityCollectorWorkflow(input: ActivityCollectorInput): Promise<void> {
  "use workflow";

  const batches = createHook<ActivityBatchV1>({ token: input.token });
  const iterator = batches[Symbol.asyncIterator]();
  let ownsHook = false;
  let pendingRead: Promise<IteratorResult<ActivityBatchV1>> | undefined;
  const expiry = sleep(new Date(input.expiresAt)).then(() => ({ kind: "expired" as const }));
  let snapshot = createActivitySnapshot();
  let rendererStates: Readonly<Record<string, unknown>> = {};

  try {
    try {
      await claimHookOwnership(batches);
      ownsHook = true;
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
      if (next.kind === "expired" || next.value.done === true) break;
      pendingRead = undefined;
      snapshot = reduceActivityBatch(snapshot, next.value.value);
      if (snapshot.revision === 0) continue;

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
    }
  } finally {
    if (ownsHook) {
      await closeHookIterator(iterator).catch(() => {});
      await disposeHook(batches).catch(() => {});
      await disposeSessionActivityStep({
        rendererStates,
        serializedContext: input.serializedContext,
      }).catch(() => {});
    }
  }
}

import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import { createProgressSnapshot, reduceProgressBatch } from "#execution/session-progress.js";
import type { ProgressBatchV1 } from "#protocol/progress.js";
import {
  disposeSessionProgressStep,
  renderSessionProgressStep,
} from "#execution/session-progress-renderer-step.js";

const RENDER_DEBOUNCE_MS = 350;

export interface ProgressCollectorInput {
  readonly expiresAt: string;
  readonly serializedContext: Record<string, unknown>;
  readonly token: string;
}

/** Independently owns progress reduction and provider presentation for one root session. */
export async function progressCollectorWorkflow(input: ProgressCollectorInput): Promise<void> {
  "use workflow";

  const batches = createHook<ProgressBatchV1>({ token: input.token });
  const iterator = batches[Symbol.asyncIterator]();
  let ownsHook = false;
  let pendingRead: Promise<IteratorResult<ProgressBatchV1>> | undefined;
  const expiry = sleep(new Date(input.expiresAt)).then(() => ({ kind: "expired" as const }));
  let snapshot = createProgressSnapshot();
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
      snapshot = reduceProgressBatch(snapshot, next.value.value);
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
        snapshot = reduceProgressBatch(snapshot, buffered.value.value);
      }

      const rendered = await renderSessionProgressStep({
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
      await disposeSessionProgressStep({
        rendererStates,
        serializedContext: input.serializedContext,
      }).catch(() => {});
    }
  }
}

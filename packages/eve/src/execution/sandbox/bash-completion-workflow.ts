import { createHook, sleep } from "#compiled/@workflow/core/index.js";

import {
  type BashCompletionControl,
  type BashCompletionMonitorInput,
  type BashCompletionMonitorResult,
} from "#execution/sandbox/bash-completion-contract.js";
import {
  deliverBashCompletionStep,
  inspectBashCommandStep,
  killBashCommandStep,
} from "#execution/sandbox/bash-completion-steps.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";

const MONITOR_POLL_INTERVAL_MS = 1_000;
const MONITOR_ACTIVATION_TIMEOUT_MS = 60_000;

/** Durable single-writer for completion delivery and kill suppression. */
export async function bashCompletionWorkflow(
  input: BashCompletionMonitorInput,
): Promise<BashCompletionMonitorResult> {
  "use workflow";

  const control = createHook<BashCompletionControl>({ token: input.controlToken });
  const iterator = control[Symbol.asyncIterator]();
  let ownsControl = false;
  try {
    try {
      await claimHookOwnership(control);
      ownsControl = true;
    } catch (error) {
      if (isHookConflictError(error)) return { status: "closed" };
      throw error;
    }

    const initial = await Promise.race([
      iterator.next().then((result) => ({ kind: "control" as const, result })),
      sleep(MONITOR_ACTIVATION_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
    ]);
    if (
      initial.kind === "timeout" ||
      initial.result.done ||
      initial.result.value.kind === "close"
    ) {
      return { status: "closed" };
    }
    if (initial.result.value.kind === "kill") {
      return await killBashCommandStep(input);
    }

    let pendingControl = iterator.next();
    while (true) {
      const winner = await Promise.race([
        pendingControl.then((result) => ({ kind: "control" as const, result })),
        sleep(MONITOR_POLL_INTERVAL_MS).then(() => ({ kind: "poll" as const })),
      ]);
      if (winner.kind === "control") {
        if (winner.result.done || winner.result.value.kind === "close") {
          return { status: "closed" };
        }
        if (winner.result.value.kind === "kill") {
          return await killBashCommandStep(input);
        }
        pendingControl = iterator.next();
        continue;
      }

      const observation = await inspectBashCommandStep(input);
      if (observation.exitCode === undefined) continue;
      const completed = { ...observation, exitCode: observation.exitCode };
      await deliverBashCompletionStep({ ...input, observation: completed });
      return { observation: completed, status: "completed" };
    }
  } finally {
    if (ownsControl) await disposeHook(control);
  }
}

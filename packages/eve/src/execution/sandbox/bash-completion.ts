import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  bashCompletionControlToken,
  bashCompletionDeliveryId,
  type BashCompletionControl,
  type BashCompletionMonitorInput,
  type BashCompletionMonitorResult,
} from "#execution/sandbox/bash-completion-contract.js";
import { resolveBashInlineWaitMs, supportsDurableBashCompletion } from "#execution/sandbox/bash.js";
import {
  bashCompletionWorkflowReference,
  startWorkflowPreferLatest,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";

const MONITOR_HOOK_READY_TIMEOUT_MS = 5_000;

export type { BashCompletionMonitorResult } from "#execution/sandbox/bash-completion-contract.js";

export interface BashCompletionMonitorHandle {
  readonly controlToken: string;
  readonly processId: string;
}

/** Starts a dormant durable monitor and waits until it owns its control hook. */
export async function startBashCompletionMonitor(input: {
  readonly processId: string;
  readonly sessionId: string;
}): Promise<BashCompletionMonitorHandle | undefined> {
  const ctx = loadContext();
  const sandboxAccess = ctx.require(SandboxKey);
  const sandbox = await sandboxAccess.get();
  if (sandbox === null || !supportsDurableBashCompletion(sandbox)) return undefined;

  const sandboxState = await sandboxAccess.captureState();
  if (sandboxState.session === null) {
    throw new Error("Cannot monitor a Bash command before its sandbox state is reconnectable.");
  }

  const controlToken = bashCompletionControlToken(input.sessionId, input.processId);
  const monitorInput: BashCompletionMonitorInput = {
    controlToken,
    deliveryId: bashCompletionDeliveryId(input.sessionId, input.processId),
    processId: input.processId,
    sandboxState,
    serializedContext: serializeContext(ctx),
    sessionId: input.sessionId,
  };
  await startWorkflowPreferLatest(bashCompletionWorkflowReference, [monitorInput]);
  await waitForCommandHookOwner(controlToken, {
    timeoutMs: resolveBashInlineWaitMs(MONITOR_HOOK_READY_TIMEOUT_MS),
  });
  return { controlToken, processId: input.processId };
}

export async function activateBashCompletionMonitor(
  monitor: BashCompletionMonitorHandle,
): Promise<void> {
  await resumeHook(monitor.controlToken, { kind: "activate" } satisfies BashCompletionControl);
}

export async function closeBashCompletionMonitor(
  monitor: BashCompletionMonitorHandle,
): Promise<void> {
  await resumeHook(monitor.controlToken, { kind: "close" } satisfies BashCompletionControl);
}

/** Routes kill through the monitor so kill and completion cannot both commit. */
export async function killBashCompletionMonitor(input: {
  readonly processId: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
}): Promise<BashCompletionMonitorResult | undefined> {
  const controlToken = bashCompletionControlToken(input.sessionId, input.processId);
  let owner: Awaited<ReturnType<typeof resumeHook>>;
  try {
    owner = await resumeHook(controlToken, { kind: "kill" } satisfies BashCompletionControl);
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getRun<BashCompletionMonitorResult>(owner.runId).returnValue,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the Bash monitor to acknowledge kill.")),
          input.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

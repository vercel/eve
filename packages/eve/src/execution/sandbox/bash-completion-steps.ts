import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import { createSandboxProviderValue } from "#context/providers/sandbox.js";
import { deserializeContext } from "#context/serialize.js";
import type {
  BashCompletionMonitorInput,
  BashCompletionMonitorResult,
} from "#execution/sandbox/bash-completion-contract.js";
import {
  getBackgroundBashProcess,
  supportsDurableBashCompletion,
} from "#execution/sandbox/bash.js";
import type { ManagedSandboxCommandObservation } from "#execution/sandbox/managed-command.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { walkCauseChain } from "#shared/errors.js";

export async function inspectBashCommandStep(
  input: BashCompletionMonitorInput,
): Promise<ManagedSandboxCommandObservation> {
  "use step";
  return await withBashCommand(input, async (command) => await command.inspect());
}

export async function killBashCommandStep(
  input: BashCompletionMonitorInput,
): Promise<BashCompletionMonitorResult> {
  "use step";
  return await withBashCommand(input, async (command) => {
    const observation = await command.inspect();
    if (observation.exitCode !== undefined) {
      return { observation, status: "completed" };
    }
    await command.terminate();
    return { observation, status: "killed" };
  });
}

export async function deliverBashCompletionStep(
  input: BashCompletionMonitorInput & {
    readonly observation: ManagedSandboxCommandObservation & { readonly exitCode: number };
  },
): Promise<void> {
  "use step";
  try {
    await resumeSessionInbox(sessionCommandHookToken(input.sessionId), {
      kind: "send",
      payload: { message: formatBashCompletionMessage(input.processId, input.observation) },
      // This is the session inbox's replay-stable delivery dedupe lane. The
      // notification does not create a TaskView or use a task payload.
      taskDeliveryId: input.deliveryId,
      turnPolicy: "queue",
    });
  } catch (error) {
    if (!isInactiveSessionTarget(error)) throw error;
  }
}

export function formatBashCompletionMessage(
  processId: string,
  observation: ManagedSandboxCommandObservation & { readonly exitCode: number },
): string {
  return [
    `Bash process ${processId} completed with exit code ${observation.exitCode}.`,
    "",
    "stdout:",
    observation.stdout,
    "",
    "stderr:",
    observation.stderr,
  ].join("\n");
}

async function withBashCommand<T>(
  input: BashCompletionMonitorInput,
  callback: (command: Awaited<ReturnType<typeof getBackgroundBashProcess>>) => Promise<T>,
): Promise<T> {
  const ctx = await deserializeContext(input.serializedContext);
  const provider = await createSandboxProviderValue(ctx, input.sandboxState);
  const sandbox = await provider?.value.get();
  if (sandbox === null || sandbox === undefined || !supportsDurableBashCompletion(sandbox)) {
    throw new Error("The sandbox backend cannot reconnect to a monitored Bash command.");
  }
  return await callback(await getBackgroundBashProcess(sandbox, input.processId));
}

function isInactiveSessionTarget(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      HookNotFoundError.is(candidate) ||
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}

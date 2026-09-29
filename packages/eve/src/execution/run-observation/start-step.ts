import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getHookByToken, getRun } from "#internal/workflow/runtime.js";
import { deserializeContext } from "#context/serialize.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSlackObservation } from "#public/channels/slack/observation/ownership.js";
import {
  startWorkflowOnCurrentDeployment,
  runObservationWorkflowReference,
} from "#execution/workflow-runtime.js";
import type { RunObservationInput } from "#execution/run-observation/workflow.js";

/** One-time launch from session initialization; a replay finds the same claimed owner. */
export async function startRunObservationStep(input: {
  readonly expiresAt: string;
  readonly rootSessionId: string;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  if (
    getSlackObservation(adapter) === undefined ||
    typeof adapter.state?.["channelId"] !== "string" ||
    typeof adapter.state?.["threadTs"] !== "string" ||
    !adapter.state["threadTs"]
  ) {
    throw new Error("Slack observation requires a configured channel and an existing thread.");
  }
  const token = `eve:run-observation:v1:${input.rootSessionId}`;
  try {
    await getHookByToken(token);
    return;
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
  const payload: RunObservationInput = { ...input, token };
  const run = await startWorkflowOnCurrentDeployment(runObservationWorkflowReference, [payload]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const hook = await getHookByToken(token);
      if (hook.runId !== run.runId)
        throw new Error("Another run claimed the Slack observation owner.");
      return;
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
    }
    const status = await getRun(run.runId).status;
    if (status === "failed" || status === "cancelled" || status === "completed") {
      throw new Error(`Slack observation exited before claiming ownership (${status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Slack observation did not claim ownership within 10 seconds.");
}

import {
  createHarnessWorkflowState,
  finalizeHarnessWorkflow,
  type HarnessWorkflowState,
} from "@ai-sdk/workflow-harness";
import type { WorkflowToolContext } from "eve/tools";

import type { HarnessAgentToolInput } from "../types";
import type { ReviewerAgentOutput } from "./runtime";

export async function reviewerWorkflow(
  input: HarnessAgentToolInput,
  ctx: WorkflowToolContext,
): Promise<ReviewerAgentOutput> {
  "use workflow";

  let state = createHarnessWorkflowState({
    prompt: input.task,
    sessionId: ctx.callId,
  });
  let result: Awaited<ReturnType<typeof reviewerStep>>;
  do {
    result = await reviewerStep({ ctx, input, state });
    state = result.state;
  } while (state.status === "ready_for_next_step");

  finalizeHarnessWorkflow(state);
  if (!("output" in result)) {
    throw new Error("The HarnessAgent workflow finished without an output.");
  }
  return result.output;
}

async function reviewerStep(input: {
  readonly ctx: WorkflowToolContext;
  readonly input: HarnessAgentToolInput;
  readonly state: HarnessWorkflowState;
}) {
  "use step";

  const [{ createClaudeCode }, { runHarnessAgentStep }, { tool }] = await Promise.all([
    import("@ai-sdk/harness-claude-code"),
    import("../run-harness-agent-step"),
    import("./runtime"),
  ]);
  const workDir = input.input.workDir ?? tool.agentSettings.workDir;
  return await runHarnessAgentStep({
    ...tool.agentSettings,
    ctx: input.ctx,
    harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
    state: input.state,
    ...(workDir === undefined ? {} : { workDir }),
  });
}

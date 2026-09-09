import {
  createHarnessWorkflowState,
  finalizeHarnessWorkflow,
  type HarnessWorkflowState,
} from "@ai-sdk/workflow-harness";
import type { WorkflowToolContext } from "eve/tools";

import type { HarnessAgentToolInput } from "../types";

export async function implementerWorkflow(
  input: HarnessAgentToolInput,
  ctx: WorkflowToolContext,
): Promise<string> {
  "use workflow";

  let state = createHarnessWorkflowState({
    prompt: input.task,
    sessionId: ctx.callId,
  });
  let result: Awaited<ReturnType<typeof implementerStep>>;
  do {
    result = await implementerStep({ ctx, input, state });
    state = result.state;
  } while (state.status === "ready_for_next_step");

  finalizeHarnessWorkflow(state);
  if (!("output" in result)) {
    throw new Error("The HarnessAgent workflow finished without an output.");
  }
  return result.output;
}

async function implementerStep(input: {
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

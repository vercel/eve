import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { getWorkflowMetadata } from "workflow";
import { z } from "zod";
import {
  AUTH_SNAPSHOT_MARKER,
  lifecycleGate,
  publishLifecycleControl,
  type LifecycleMarker,
} from "../lib/lifecycle-control.js";

type Input = {
  key: string;
  marker: Exclude<LifecycleMarker, "parent">;
  child: boolean;
  delayedAuthChild?: boolean;
};

async function execute(
  { key, marker, child, delayedAuthChild }: Input,
  ctx: WorkflowToolContext,
): Promise<string> {
  "use workflow";
  const parentSessionId = ctx.session.id;
  await publishLifecycleControl(parentSessionId, key, {
    kind: "owner",
    marker,
    runId: getWorkflowMetadata().workflowRunId,
    sessionId: parentSessionId,
    turnId: ctx.session.turn.id,
  });
  if (delayedAuthChild === true) {
    await lifecycleGate({
      parentSessionId,
      key,
      marker,
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    });
    await ctx.agent("auth-snapshot-worker", {
      message: "Call snapshot_whoami exactly once.",
    });
  } else if (child) {
    try {
      await ctx.agent("lifecycle-worker", {
        message: JSON.stringify({ parentSessionId, key, marker }),
      });
      throw new Error("Bob's terminal model rejection was not observed.");
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        Reflect.get(error, "code") !== "SUBAGENT_EXECUTION_FAILED" ||
        !String(Reflect.get(error, "message")).includes("LIFECYCLE-TERMINAL-REJECTION")
      )
        throw error;
    }
  } else {
    await lifecycleGate({
      parentSessionId,
      key,
      marker,
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    });
  }
  return `LIFECYCLE:${marker}`;
}

const tool: WorkflowToolDefinition<Input, string> = defineWorkflowTool({
  description: "Coordinate independently released background work for lifecycle checks.",
  execution: "background",
  inputSchema: z.object({
    key: z.string().uuid(),
    marker: z.enum(["A", "B", AUTH_SNAPSHOT_MARKER]),
    child: z.boolean(),
    delayedAuthChild: z.boolean().optional(),
  }),
  execute,
});

export default tool;

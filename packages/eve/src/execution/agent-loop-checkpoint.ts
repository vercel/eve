import {
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
} from "#compiled/@workflow/core/index.js";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { getRun } from "#internal/workflow/runtime.js";

const AGENT_LOOP_CHECKPOINT_VERSION = 1;
const AGENT_LOOP_CHECKPOINT_NAMESPACE_PREFIX = "eve.agent-loop-checkpoint";

export interface AgentLoopCheckpoint {
  readonly completedSteps: number;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly version: typeof AGENT_LOOP_CHECKPOINT_VERSION;
}

export async function resumeAgentLoopCheckpoint(input: {
  readonly enabled: boolean;
  readonly rawInput: TurnStepInput;
}): Promise<{ readonly checkpoint?: AgentLoopCheckpoint; readonly stepInput: TurnStepInput }> {
  const checkpoint = input.enabled ? await readAgentLoopCheckpoint() : undefined;
  return checkpoint === undefined
    ? { stepInput: input.rawInput }
    : {
        checkpoint,
        stepInput: {
          ...input.rawInput,
          input: undefined,
          serializedContext: checkpoint.serializedContext,
          sessionState: checkpoint.sessionState,
        },
      };
}

export async function readAgentLoopCheckpoint(): Promise<AgentLoopCheckpoint | undefined> {
  const { attempt, stepId } = getStepMetadata();
  if (attempt === 1) return undefined;
  return readCheckpointTail(checkpointNamespace(stepId));
}

export async function writeAgentLoopCheckpoint(
  checkpoint: Omit<AgentLoopCheckpoint, "version">,
): Promise<AgentLoopCheckpoint> {
  const namespace = checkpointNamespace(getStepMetadata().stepId);
  const writer = getWritable<AgentLoopCheckpoint>({ namespace }).getWriter();
  const persisted: AgentLoopCheckpoint = {
    ...checkpoint,
    version: AGENT_LOOP_CHECKPOINT_VERSION,
  };
  try {
    await writer.write(persisted);
  } finally {
    writer.releaseLock();
  }
  return persisted;
}

async function readCheckpointTail(namespace: string): Promise<AgentLoopCheckpoint | undefined> {
  const metadata = getWorkflowMetadata();
  const runId = metadata.workflowRunId;
  if (typeof runId !== "string") {
    throw new Error("Agent loop checkpointing requires a Workflow run id.");
  }
  const run = getRun<unknown>(runId);
  const tail = run.getReadable<AgentLoopCheckpoint>({ namespace });
  if ((await tail.getTailIndex()) === -1) return undefined;
  const reader = run.getReadable<unknown>({ namespace, startIndex: -1 }).getReader();
  try {
    const result = await reader.read();
    return result.done ? undefined : parseAgentLoopCheckpoint(result.value);
  } finally {
    await reader.cancel("eve agent loop checkpoint tail read complete").catch(() => {});
    reader.releaseLock();
  }
}

function parseAgentLoopCheckpoint(value: unknown): AgentLoopCheckpoint {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { readonly version?: unknown }).version !== AGENT_LOOP_CHECKPOINT_VERSION
  ) {
    throw new Error("Agent loop checkpoint has an unsupported or malformed version.");
  }
  return value as AgentLoopCheckpoint;
}

function checkpointNamespace(stepId: string): string {
  return `${AGENT_LOOP_CHECKPOINT_NAMESPACE_PREFIX}:${stepId}`;
}

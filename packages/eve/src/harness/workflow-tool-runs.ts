import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { z } from "#compiled/zod/index.js";
import type { SessionStateMap } from "#harness/types.js";
import { parseActivityWorkIdentityV1, type ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { JsonValue } from "#shared/json.js";
import { sameTaskMetadata, type TaskMetadata, type TaskView } from "#tasks/types.js";
import type { DurableDynamicSubagentSelection, SessionAuth } from "#context/keys.js";

// Keep the persisted key and envelope stable across the terminology change.
export const WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.runtime.workflowInvocations";
const WORKFLOW_TOOL_RUNS_VERSION = 1;

export interface WorkflowTaskPayload {
  readonly taskId: string;
  readonly metadata: TaskMetadata;
  readonly dispatchContext: TaskAgentDispatchContext;
  readonly activityWorkIdentity?: ActivityWorkIdentityV1;
  readonly cohortId?: string;
  /** Parent-owned outcome. Read through readWorkflowTaskView before consuming it. */
  readonly terminalView?: unknown;
}

interface WorkflowToolRunBase {
  readonly callId: string;
  readonly toolName: string;
  readonly resultKind: "tool" | "subagent";
  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
}
export type BlockingWorkflowToolRun = WorkflowToolRunBase & { readonly lifetime: "turn" };
export type BackgroundWorkflowToolRun = WorkflowToolRunBase & {
  readonly lifetime: "session";
  readonly task: WorkflowTaskPayload;
};
export type WorkflowToolRun = BlockingWorkflowToolRun | BackgroundWorkflowToolRun;

const taskMetadataSchema = z.looseObject({
  kind: z.string().min(1),
  name: z.string().min(1),
}) as z.ZodType<TaskMetadata>;

export interface TaskAgentDispatchContext {
  readonly auth: SessionAuth;
  readonly sessionDynamicSubagentSelections?: Readonly<
    Record<string, DurableDynamicSubagentSelection>
  >;
  readonly turnDynamicSubagentSelections?: Readonly<
    Record<string, DurableDynamicSubagentSelection>
  >;
}

const sessionAuthContextSchema = z.strictObject({
  attributes: z.record(z.string(), z.union([z.string(), z.array(z.string()).readonly()])),
  authenticator: z.string(),
  issuer: z.string().optional(),
  principalId: z.string(),
  principalType: z.string(),
  subject: z.string().optional(),
});
const dynamicSubagentSelectionsSchema = z.record(
  z.string(),
  z.custom<DurableDynamicSubagentSelection>(),
);

const taskAgentDispatchContextSchema: z.ZodType<TaskAgentDispatchContext> = z.strictObject({
  auth: z.strictObject({
    current: sessionAuthContextSchema.nullable(),
    initiator: sessionAuthContextSchema.nullable(),
  }),
  sessionDynamicSubagentSelections: dynamicSubagentSelectionsSchema.optional(),
  turnDynamicSubagentSelections: dynamicSubagentSelectionsSchema.optional(),
});
const taskViewBaseShape = {
  // Terminal views never carry pending requests; the loose object must say so explicitly.
  inputRequests: z.never().optional(),
  metadata: taskMetadataSchema,
  taskId: z.string().min(1),
  usage: z
    .looseObject({
      cacheReadTokens: z.number().nonnegative(),
      cacheWriteTokens: z.number().nonnegative(),
      costUsd: z.number().finite().nonnegative().optional(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    })
    .optional(),
};

/** Only the parent records terminal outcomes; input routes live in its proxy state. */
const taskViewSchema: z.ZodType<TaskView> = z.discriminatedUnion("status", [
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.looseObject({ data: z.custom<JsonValue>(), type: z.literal("result") }),
    status: z.literal("completed"),
  }),
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.looseObject({ data: z.custom<JsonValue>(), type: z.literal("error") }),
    status: z.literal("failed"),
  }),
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.never().optional(),
    status: z.literal("cancelled"),
  }),
]);

const commonShape = {
  callId: z.string().min(1),
  toolName: z.string().min(1),
  resultKind: z.enum(["tool", "subagent"]),
  origin: z.looseObject({ turnId: z.string().min(1), stepIndex: z.number().int().nonnegative() }),
  address: z.looseObject({ runId: z.string().min(1), hookToken: z.string().min(1) }),
};
const invocationSchema: z.ZodType<WorkflowToolRun> = z.discriminatedUnion("lifetime", [
  z.looseObject({ ...commonShape, lifetime: z.literal("turn"), task: z.never().optional() }),
  z.looseObject({
    ...commonShape,
    lifetime: z.literal("session"),
    task: z.looseObject({
      taskId: z.string().min(1),
      metadata: taskMetadataSchema,
      dispatchContext: taskAgentDispatchContextSchema,
      activityWorkIdentity: z
        .custom<ActivityWorkIdentityV1>((value) => parseActivityWorkIdentityV1(value) !== undefined)
        .optional(),
      cohortId: z.string().min(1).optional(),
      terminalView: z.unknown().optional(),
    }),
  }),
]);
const registrySchema = z
  .looseObject({
    version: z.literal(WORKFLOW_TOOL_RUNS_VERSION),
    invocations: z.array(invocationSchema),
  })
  .superRefine((registry, ctx) => {
    const identities = new Set<string>();
    const tasks = new Set<string>();
    for (const entry of registry.invocations) {
      const identity = JSON.stringify([entry.origin.turnId, entry.callId]);
      if (identities.has(identity))
        ctx.addIssue({ code: "custom", message: "Invocation identities must be unique." });
      identities.add(identity);
      if (entry.lifetime !== "session") continue;
      const task = entry.task;
      if (tasks.has(task.taskId))
        ctx.addIssue({ code: "custom", message: "Task ids must be unique." });
      tasks.add(task.taskId);
    }
  });

/** Decode retained output only when it is consumed, independently of ownership reads. */
export function readWorkflowTaskView(task: WorkflowTaskPayload): TaskView | undefined {
  if (task.terminalView === undefined) return undefined;
  const result = taskViewSchema.safeParse(task.terminalView);
  if (!result.success)
    throw new Error(`Corrupt workflow task result "${task.taskId}": ${result.error.message}`);
  if (result.data.taskId !== task.taskId || !sameTaskMetadata(result.data.metadata, task.metadata))
    throw new Error(
      `Corrupt workflow task result "${task.taskId}": terminal view does not match its owner.`,
    );
  return result.data;
}

function readRegistry(state: SessionStateMap | undefined): z.infer<typeof registrySchema> {
  if (state?.["eve.tasks"] !== undefined || state?.["eve.runtime.workflowToolRuns"] !== undefined) {
    throw new Error(
      "Unsupported workflow invocation state: start a new session or import its conversation.",
    );
  }
  const raw = state?.[WORKFLOW_TOOL_RUNS_STATE_KEY];
  if (raw === undefined) return { version: WORKFLOW_TOOL_RUNS_VERSION, invocations: [] };
  const result = registrySchema.safeParse(raw);
  if (!result.success)
    throw new Error(`Corrupt workflow invocation registry: ${result.error.message}`);
  return result.data;
}

export function getWorkflowToolRuns(
  state: SessionStateMap | undefined,
): readonly WorkflowToolRun[] {
  return readRegistry(state).invocations;
}

export function getBackgroundWorkflowToolRuns(
  state: SessionStateMap | undefined,
): readonly BackgroundWorkflowToolRun[] {
  return getWorkflowToolRuns(state).filter(
    (entry): entry is BackgroundWorkflowToolRun => entry.lifetime === "session",
  );
}

export function getBlockingWorkflowToolRuns(
  state: SessionStateMap | undefined,
  turnId?: string,
): readonly BlockingWorkflowToolRun[] {
  return getWorkflowToolRuns(state).filter(
    (entry): entry is BlockingWorkflowToolRun =>
      entry.lifetime === "turn" && (turnId === undefined || entry.origin.turnId === turnId),
  );
}

export function findBackgroundWorkflowToolRun(
  state: SessionStateMap | undefined,
  taskId: string,
): BackgroundWorkflowToolRun | undefined {
  return getBackgroundWorkflowToolRuns(state).find((entry) => entry.task.taskId === taskId);
}

function writeRegistry(
  state: SessionStateMap | undefined,
  registry: z.infer<typeof registrySchema>,
): SessionStateMap | undefined {
  if (registry.invocations.length === 0) {
    const next = { ...state };
    delete next[WORKFLOW_TOOL_RUNS_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return {
    ...state,
    [WORKFLOW_TOOL_RUNS_STATE_KEY]: registrySchema.parse(registry),
  };
}

/** Registration is idempotent by originating turn and call; retained task facts survive replay. */
export function registerWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: WorkflowToolRun,
): T {
  const registry = readRegistry(session.state);
  const invocations = [...registry.invocations];
  const index = invocations.findIndex(
    (candidate) =>
      candidate.origin.turnId === entry.origin.turnId && candidate.callId === entry.callId,
  );
  const previous = invocations[index];
  if (
    previous !== undefined &&
    (previous.lifetime !== entry.lifetime ||
      previous.toolName !== entry.toolName ||
      previous.resultKind !== entry.resultKind)
  ) {
    throw new Error("Replayed invocation changed its ownership or tool identity.");
  }
  if (entry.lifetime === "session") {
    if (previous?.lifetime === "session") {
      if (entry.task.taskId !== previous.task.taskId)
        throw new Error("Replayed invocation changed its task identity.");
      entry = {
        ...entry,
        task: {
          ...previous.task,
          ...entry.task,
          metadata: { ...previous.task.metadata, ...entry.task.metadata },
          activityWorkIdentity:
            entry.task.activityWorkIdentity === undefined
              ? previous.task.activityWorkIdentity
              : { ...previous.task.activityWorkIdentity, ...entry.task.activityWorkIdentity },
          cohortId: previous.task.cohortId,
          dispatchContext: previous.task.dispatchContext,
          terminalView: previous.task.terminalView ?? entry.task.terminalView,
        },
      };
    } else {
      const pending = invocations.find(
        (candidate): candidate is BackgroundWorkflowToolRun =>
          candidate.lifetime === "session" && candidate.task.terminalView === undefined,
      );
      entry = {
        ...entry,
        task: {
          ...entry.task,
          cohortId:
            pending === undefined ? undefined : (pending.task.cohortId ?? pending.task.taskId),
        },
      };
    }
  }
  if (entry.lifetime === "session") readWorkflowTaskView(entry.task);
  if (previous === undefined) invocations.push(entry);
  else
    invocations[index] = {
      ...previous,
      ...entry,
      origin: previous.origin,
      address: { ...previous.address, ...entry.address },
    };
  return { ...session, state: writeRegistry(session.state, { ...registry, invocations }) };
}

/** Task payloads remain available for the session lifetime, including after report delivery. */
export function recordWorkflowTaskView(
  state: SessionStateMap | undefined,
  view: TaskView,
): SessionStateMap | undefined {
  const terminal = taskViewSchema.parse(view);
  const registry = readRegistry(state);
  const invocations = [...registry.invocations];
  const index = invocations.findIndex(
    (entry) => entry.lifetime === "session" && entry.task.taskId === terminal.taskId,
  );
  const entry = invocations[index];
  if (entry === undefined || entry.lifetime !== "session") return state;
  if (!sameTaskMetadata(entry.task.metadata, terminal.metadata))
    throw new Error(`Task view metadata does not match invocation "${view.taskId}".`);
  const previous = readWorkflowTaskView(entry.task);
  // Parent delivery order decides settlement. Replays and late outcomes cannot replace it.
  if (previous !== undefined) return state;
  invocations[index] = {
    ...entry,
    task: {
      ...entry.task,
      terminalView: terminal,
    },
  };
  return writeRegistry(state, { ...registry, invocations });
}

/** Removes only this turn's waiting calls. Session-owned task payloads are never pruned here. */
export function removeBlockingWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const registry = readRegistry(session.state);
  const entries = registry.invocations;
  const remaining = entries.filter(
    (entry) =>
      entry.lifetime !== "turn" ||
      entry.origin.turnId !== turnId ||
      (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === entries.length
    ? session
    : { ...session, state: writeRegistry(session.state, { ...registry, invocations: remaining }) };
}

/** Results without an originating turn may bind only when exactly one recorded turn owns the call. */
export function findBlockingWorkflowToolRun(
  state: SessionStateMap | undefined,
  callId: string,
  turnId?: string,
): BlockingWorkflowToolRun | undefined {
  const candidates = getBlockingWorkflowToolRuns(state, turnId).filter(
    (entry) => entry.callId === callId,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
/** The turn inbox is shared; a result settles a call only if the turn recorded that run. */
export function isInboxToolResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: RuntimeToolResultActionResult,
): boolean {
  const record = findBlockingWorkflowToolRun(state, result.callId);
  return (
    record !== undefined && record.resultKind !== "subagent" && record.toolName === result.toolName
  );
}

/** A child result reported through a shared subagent execute run. */
export function isInboxSubagentResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: { readonly callId: string; readonly subagentName: string },
): boolean {
  const record = findBlockingWorkflowToolRun(state, result.callId);
  return record?.resultKind === "subagent" && record.toolName === result.subagentName;
}

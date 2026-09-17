import { z } from "#compiled/zod/index.js";
import type { SessionStateMap } from "#harness/types.js";
import { parseActivityWorkIdentityV1, type ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { JsonValue } from "#shared/json.js";
import { sameTaskMetadata, type TaskMetadata, type TaskView } from "#tasks/types.js";
import type { DurableDynamicSubagentSelection, SessionAuth } from "#context/keys.js";

export const WORKFLOW_INVOCATIONS_STATE_KEY = "eve.runtime.workflowInvocations";
const WORKFLOW_INVOCATIONS_VERSION = 1;

export interface WorkflowTaskPayload {
  readonly taskId: string;
  readonly metadata: TaskMetadata;
  readonly dispatchContext: TaskAgentDispatchContext;
  readonly activityWorkIdentity?: ActivityWorkIdentityV1;
  readonly cohortId?: string;
  readonly terminalView?: TaskView;
}

interface WorkflowInvocationBase {
  readonly callId: string;
  readonly toolName: string;
  readonly resultKind: "tool" | "subagent";
  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
}
export type TurnWorkflowInvocation = WorkflowInvocationBase & { readonly lifetime: "turn" };
export type TaskWorkflowInvocation = WorkflowInvocationBase & {
  readonly lifetime: "session";
  readonly task: WorkflowTaskPayload;
};
export type WorkflowInvocation = TurnWorkflowInvocation | TaskWorkflowInvocation;

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

/**
 * Terminal views only, on purpose: the index caches a view solely as
 * the expired-run fallback, and the discriminated arms encode the terminal
 * status/output invariants structurally (explicit fields reject
 * `inputRequests` and mismatched outputs while preserving additive metadata).
 */
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
const invocationSchema: z.ZodType<WorkflowInvocation> = z.discriminatedUnion("lifetime", [
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
      terminalView: taskViewSchema.optional(),
    }),
  }),
]);
const registrySchema = z
  .looseObject({
    version: z.literal(WORKFLOW_INVOCATIONS_VERSION),
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
      if (
        task.terminalView !== undefined &&
        (task.terminalView.taskId !== task.taskId ||
          !sameTaskMetadata(task.terminalView.metadata, task.metadata))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Cached terminal views must match their invocation task payload.",
        });
      }
    }
  });

function readRegistry(state: SessionStateMap | undefined) {
  if (state?.["eve.tasks"] !== undefined || state?.["eve.runtime.workflowToolRuns"] !== undefined) {
    throw new Error(
      "Unsupported workflow invocation state: start a new session or import its conversation.",
    );
  }
  const raw = state?.[WORKFLOW_INVOCATIONS_STATE_KEY];
  if (raw === undefined) return { version: WORKFLOW_INVOCATIONS_VERSION, invocations: [] };
  const result = registrySchema.safeParse(raw);
  if (!result.success)
    throw new Error(`Corrupt workflow invocation registry: ${result.error.message}`);
  return result.data;
}

export function getWorkflowInvocations(
  state: SessionStateMap | undefined,
): readonly WorkflowInvocation[] {
  return readRegistry(state).invocations;
}

export function getTaskInvocations(
  state: SessionStateMap | undefined,
): readonly TaskWorkflowInvocation[] {
  return getWorkflowInvocations(state).filter(
    (entry): entry is TaskWorkflowInvocation => entry.lifetime === "session",
  );
}

export function getTurnInvocations(
  state: SessionStateMap | undefined,
  turnId: string,
): readonly TurnWorkflowInvocation[] {
  return getWorkflowInvocations(state).filter(
    (entry): entry is TurnWorkflowInvocation =>
      entry.lifetime === "turn" && entry.origin.turnId === turnId,
  );
}

export function findTaskInvocation(
  state: SessionStateMap | undefined,
  taskId: string,
): TaskWorkflowInvocation | undefined {
  return getTaskInvocations(state).find((entry) => entry.task.taskId === taskId);
}

export function findTurnInvocation(
  state: SessionStateMap | undefined,
  turnId: string,
  callId: string,
): TurnWorkflowInvocation | undefined {
  return getTurnInvocations(state, turnId).find((entry) => entry.callId === callId);
}

function writeRegistry(
  state: SessionStateMap | undefined,
  invocations: readonly WorkflowInvocation[],
): SessionStateMap | undefined {
  if (invocations.length === 0) {
    const next = { ...state };
    delete next[WORKFLOW_INVOCATIONS_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  const registry = readRegistry(state);
  return {
    ...state,
    [WORKFLOW_INVOCATIONS_STATE_KEY]: registrySchema.parse({ ...registry, invocations }),
  };
}

/** Registration is idempotent by originating turn and call; retained task facts survive replay. */
export function registerWorkflowInvocation<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: WorkflowInvocation,
): T {
  const invocations = [...getWorkflowInvocations(session.state)];
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
    const pending = invocations.find(
      (candidate): candidate is TaskWorkflowInvocation =>
        candidate.lifetime === "session" && candidate.task.terminalView === undefined,
    );
    if (previous?.lifetime === "session") {
      if (entry.task.taskId !== previous.task.taskId)
        throw new Error("Replayed invocation changed its task identity.");
      entry = {
        ...previous,
        ...entry,
        origin: previous.origin,
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
  if (previous === undefined) invocations.push(entry);
  else
    invocations[index] = {
      ...previous,
      ...entry,
      origin: previous.origin,
      address: { ...previous.address, ...entry.address },
    };
  return { ...session, state: writeRegistry(session.state, invocations) };
}

/** Task payloads remain available for the session lifetime, including after report delivery. */
export function cacheWorkflowTaskView(
  state: SessionStateMap | undefined,
  view: TaskView,
): SessionStateMap | undefined {
  const terminal = taskViewSchema.parse(view);
  const invocations = [...getWorkflowInvocations(state)];
  const index = invocations.findIndex(
    (entry) => entry.lifetime === "session" && entry.task.taskId === terminal.taskId,
  );
  const entry = invocations[index];
  if (entry === undefined || entry.lifetime !== "session") return state;
  if (!sameTaskMetadata(entry.task.metadata, terminal.metadata))
    throw new Error(`Task view metadata does not match invocation "${view.taskId}".`);
  const previous = entry.task.terminalView;
  invocations[index] = {
    ...entry,
    task: {
      ...entry.task,
      terminalView: taskViewSchema.parse({
        ...previous,
        ...terminal,
        metadata: { ...previous?.metadata, ...terminal.metadata },
        lastOutput:
          terminal.lastOutput === undefined
            ? undefined
            : { ...previous?.lastOutput, ...terminal.lastOutput },
        usage: terminal.usage === undefined ? undefined : { ...previous?.usage, ...terminal.usage },
      }),
    },
  };
  return writeRegistry(state, invocations);
}

/** Removes only this turn's waiting calls. Session-owned task payloads are never pruned here. */
export function removeTurnInvocations<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const entries = getWorkflowInvocations(session.state);
  const remaining = entries.filter(
    (entry) =>
      entry.lifetime !== "turn" ||
      entry.origin.turnId !== turnId ||
      (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === entries.length
    ? session
    : { ...session, state: writeRegistry(session.state, remaining) };
}

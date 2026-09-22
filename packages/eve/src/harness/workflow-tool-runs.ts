import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";
import { parseActivityWorkIdentityV1, type ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  sameTaskMetadata,
  type TaskMetadata,
  type TaskOutput,
  type TaskStatus,
  type TaskUsage,
  type TaskView,
} from "#tasks/types.js";
import type { DurableDynamicSubagentSelection, SessionAuth } from "#context/keys.js";

// Version 3 replaces the task-only index with the shared workflow tool run registry.
export const WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.workflowTool";
const WORKFLOW_TOOL_RUNS_VERSION = 3;

export interface WorkflowTaskPayload {
  readonly taskId: string;
  readonly metadata: TaskMetadata;
  readonly dispatchContext: TaskAgentDispatchContext;
  readonly activityWorkIdentity?: ActivityWorkIdentityV1;
  readonly cohortId?: string;
  /** Parent-owned outcome. Read through readWorkflowTaskView before consuming it. */
  readonly outcome?: unknown;
}

/** Settled task data; identity and metadata belong to the owning task. */
type TaskOutcome = {
  readonly usage?: TaskUsage;
} & (
  | { readonly status: "completed"; readonly lastOutput: Extract<TaskOutput, { type: "result" }> }
  | { readonly status: "failed"; readonly lastOutput: Extract<TaskOutput, { type: "error" }> }
  | { readonly status: "cancelled"; readonly lastOutput?: never }
);

interface WorkflowToolRunBase {
  readonly callId: string;
  readonly toolName: string;

  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
}
export type BlockingWorkflowToolRun = WorkflowToolRunBase & { readonly lifetime: "turn" };
export type BackgroundWorkflowToolRun = WorkflowToolRunBase & {
  readonly lifetime: "session";
  readonly task: WorkflowTaskPayload;
};
export type WorkflowToolRun = BlockingWorkflowToolRun | BackgroundWorkflowToolRun;

export interface TaskAgentDispatchContext {
  readonly auth: SessionAuth;
  readonly sessionDynamicSubagentSelections?: Readonly<
    Record<string, DurableDynamicSubagentSelection>
  >;
  readonly turnDynamicSubagentSelections?: Readonly<
    Record<string, DurableDynamicSubagentSelection>
  >;
}

interface WorkflowToolRunRegistry {
  readonly version: typeof WORKFLOW_TOOL_RUNS_VERSION;
  readonly runs: readonly WorkflowToolRun[];
  readonly [key: string]: unknown;
}

// These readers run inside the workflow driver: importing a schema runtime here also
// embeds it and its source map in every deployed workflow function.
function isTaskMetadata(value: unknown): value is TaskMetadata {
  return isObject(value) && isNonEmptyString(value.kind) && isNonEmptyString(value.name);
}

/** Workflow checkpoints can carry records created in another VM realm. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const constructor = value.constructor;
  return (
    typeof constructor !== "function" ||
    (isObject(constructor.prototype) && Object.hasOwn(constructor.prototype, "isPrototypeOf"))
  );
}

function isSessionAuthContext(value: unknown): value is SessionAuthContext | null {
  return (
    value === null ||
    (isObject(value) &&
      Object.keys(value).every((key) =>
        [
          "attributes",
          "authenticator",
          "issuer",
          "principalId",
          "principalType",
          "subject",
        ].includes(key),
      ) &&
      isRecord(value.attributes) &&
      Object.values(value.attributes).every(
        (attribute) =>
          typeof attribute === "string" ||
          (Array.isArray(attribute) &&
            Array.from(attribute).every((item) => typeof item === "string")),
      ) &&
      typeof value.authenticator === "string" &&
      typeof value.principalId === "string" &&
      typeof value.principalType === "string" &&
      (value.issuer === undefined || typeof value.issuer === "string") &&
      (value.subject === undefined || typeof value.subject === "string"))
  );
}

function isTaskAgentDispatchContext(value: unknown): value is TaskAgentDispatchContext {
  return (
    isObject(value) &&
    Object.keys(value).every((key) =>
      ["auth", "sessionDynamicSubagentSelections", "turnDynamicSubagentSelections"].includes(key),
    ) &&
    isObject(value.auth) &&
    Object.keys(value.auth).every((key) => key === "current" || key === "initiator") &&
    isSessionAuthContext(value.auth.current) &&
    isSessionAuthContext(value.auth.initiator) &&
    (value.sessionDynamicSubagentSelections === undefined ||
      isRecord(value.sessionDynamicSubagentSelections)) &&
    (value.turnDynamicSubagentSelections === undefined ||
      isRecord(value.turnDynamicSubagentSelections))
  );
}

function isWorkflowToolRun(value: unknown): value is WorkflowToolRun {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.callId) ||
    !isNonEmptyString(value.toolName) ||
    !isObject(value.origin) ||
    !isNonEmptyString(value.origin.turnId) ||
    typeof value.origin.stepIndex !== "number" ||
    !Number.isSafeInteger(value.origin.stepIndex) ||
    value.origin.stepIndex < 0 ||
    !isObject(value.address) ||
    !isNonEmptyString(value.address.runId) ||
    !isNonEmptyString(value.address.hookToken)
  )
    return false;
  if (value.lifetime === "turn") return value.task === undefined;
  if (value.lifetime !== "session" || !isObject(value.task)) return false;
  const task = value.task;
  return (
    isNonEmptyString(task.taskId) &&
    isTaskMetadata(task.metadata) &&
    isTaskAgentDispatchContext(task.dispatchContext) &&
    (task.cohortId === undefined || isNonEmptyString(task.cohortId)) &&
    (task.activityWorkIdentity === undefined ||
      parseActivityWorkIdentityV1(task.activityWorkIdentity) !== undefined)
  );
}

function parseRegistry(value: unknown): WorkflowToolRunRegistry {
  if (
    !isObject(value) ||
    value.version !== WORKFLOW_TOOL_RUNS_VERSION ||
    !Array.isArray(value.runs) ||
    !Array.from(value.runs).every(isWorkflowToolRun)
  ) {
    throw new Error("Corrupt workflow tool run registry: invalid version or run.");
  }
  const identities = new Set<string>();
  const tasks = new Set<string>();
  for (const entry of value.runs) {
    const identity = JSON.stringify([entry.origin.turnId, entry.callId]);
    if (identities.has(identity))
      throw new Error("Corrupt workflow tool run registry: Run identities must be unique.");
    identities.add(identity);
    if (entry.lifetime !== "session") continue;
    if (tasks.has(entry.task.taskId))
      throw new Error("Corrupt workflow tool run registry: Task ids must be unique.");
    tasks.add(entry.task.taskId);
  }
  return {
    ...value,
    version: WORKFLOW_TOOL_RUNS_VERSION,
    runs: value.runs.map(copyWorkflowToolRun),
  };
}

function copySessionAuthContext(value: SessionAuthContext | null): SessionAuthContext | null {
  if (value === null) return null;
  return {
    ...value,
    attributes: Object.fromEntries(
      Object.entries(value.attributes).map(([key, attribute]) => [
        key,
        typeof attribute === "string" ? attribute : Object.freeze([...attribute]),
      ]),
    ),
  };
}

function copyWorkflowToolRun(entry: WorkflowToolRun): WorkflowToolRun {
  const base = { ...entry, origin: { ...entry.origin }, address: { ...entry.address } };
  if (entry.lifetime === "turn") return base;
  const dispatch = entry.task.dispatchContext;
  const dispatchContext = {
    ...dispatch,
    auth: {
      current: copySessionAuthContext(dispatch.auth.current),
      initiator: copySessionAuthContext(dispatch.auth.initiator),
    },
  };
  if (dispatch.sessionDynamicSubagentSelections !== undefined)
    dispatchContext.sessionDynamicSubagentSelections = {
      ...dispatch.sessionDynamicSubagentSelections,
    };
  if (dispatch.turnDynamicSubagentSelections !== undefined)
    dispatchContext.turnDynamicSubagentSelections = { ...dispatch.turnDynamicSubagentSelections };
  return {
    ...base,
    lifetime: "session",
    task: { ...entry.task, metadata: { ...entry.task.metadata }, dispatchContext },
  };
}

function parseTaskOutcome(value: unknown): TaskOutcome | undefined {
  if (!isObject(value) || value.inputRequests !== undefined) return undefined;
  const usage = value.usage;
  if (
    usage !== undefined &&
    (!isObject(usage) ||
      ![
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.inputTokens,
        usage.outputTokens,
        ...(usage.costUsd === undefined ? [] : [usage.costUsd]),
      ].every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0))
  )
    return undefined;
  if (value.status === "cancelled") {
    if (value.lastOutput !== undefined) return undefined;
  } else {
    if (value.status !== "completed" && value.status !== "failed") return undefined;
    const outputType = value.status === "completed" ? "result" : "error";
    if (!isObject(value.lastOutput) || value.lastOutput.type !== outputType) return undefined;
  }
  // Output data and additive fields are opaque; only the known lifecycle fields are decoded.
  const outcome = { ...value };
  if (usage !== undefined) outcome.usage = { ...usage };
  if (isObject(value.lastOutput)) outcome.lastOutput = { ...value.lastOutput };
  return outcome as TaskOutcome;
}

/** Decode retained output only when it is consumed, independently of ownership reads. */
export function readWorkflowTaskView(task: WorkflowTaskPayload): TaskView | undefined {
  if (task.outcome === undefined) return undefined;
  const outcome = parseTaskOutcome(task.outcome);
  if (outcome === undefined)
    throw new Error(`Corrupt workflow task result "${task.taskId}": invalid outcome.`);
  return { ...outcome, taskId: task.taskId, metadata: { ...task.metadata } };
}

function readRegistry(state: SessionStateMap | undefined): WorkflowToolRunRegistry {
  if (state?.["eve.tasks"] !== undefined || state?.["eve.runtime.workflowToolRuns"] !== undefined) {
    throw new Error(
      "Unsupported workflow tool run state: start a new session or import its conversation.",
    );
  }
  const raw = state?.[WORKFLOW_TOOL_RUNS_STATE_KEY];
  if (raw === undefined) return { version: WORKFLOW_TOOL_RUNS_VERSION, runs: [] };
  return parseRegistry(raw);
}

export function getWorkflowToolRuns(
  state: SessionStateMap | undefined,
): readonly WorkflowToolRun[] {
  return readRegistry(state).runs;
}

export function getBackgroundWorkflowToolRuns(
  state: SessionStateMap | undefined,
): readonly BackgroundWorkflowToolRun[] {
  return getWorkflowToolRuns(state).filter(
    (entry): entry is BackgroundWorkflowToolRun => entry.lifetime === "session",
  );
}

/** Read-only parent view: tasks without a recorded terminal outcome are working. */
export function getBackgroundTasks(state: SessionStateMap | undefined) {
  return {
    query(filter: { readonly state: Exclude<TaskStatus, "input_required"> }): readonly TaskView[] {
      return getBackgroundWorkflowToolRuns(state).flatMap(({ task }) => {
        const view = readWorkflowTaskView(task) ?? {
          taskId: task.taskId,
          metadata: task.metadata,
          status: "working" as const,
        };
        return view.status === filter.state ? [view] : [];
      });
    },
  };
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
  registry: WorkflowToolRunRegistry,
): SessionStateMap | undefined {
  if (registry.runs.length === 0) {
    const next = { ...state };
    delete next[WORKFLOW_TOOL_RUNS_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return {
    ...state,
    [WORKFLOW_TOOL_RUNS_STATE_KEY]: parseRegistry(registry),
  };
}

/** Registration is idempotent by originating turn and call; retained task facts survive replay. */
export function registerWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: WorkflowToolRun,
): T {
  const registry = readRegistry(session.state);
  const runs = [...registry.runs];
  const index = runs.findIndex(
    (candidate) =>
      candidate.origin.turnId === entry.origin.turnId && candidate.callId === entry.callId,
  );
  const previous = runs[index];
  if (
    previous !== undefined &&
    (previous.lifetime !== entry.lifetime || previous.toolName !== entry.toolName)
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
          outcome: previous.task.outcome ?? entry.task.outcome,
        },
      };
    } else {
      const pending = runs.find(
        (candidate): candidate is BackgroundWorkflowToolRun =>
          candidate.lifetime === "session" && candidate.task.outcome === undefined,
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
  if (previous === undefined) runs.push(entry);
  else
    runs[index] = {
      ...previous,
      ...entry,
      origin: previous.origin,
      address: { ...previous.address, ...entry.address },
    };
  return { ...session, state: writeRegistry(session.state, { ...registry, runs }) };
}

/** Task payloads remain available for the session lifetime, including after report delivery. */
export function recordWorkflowTaskView(
  state: SessionStateMap | undefined,
  view: TaskView,
): SessionStateMap | undefined {
  const { taskId, metadata, ...result } = view;
  const outcome = parseTaskOutcome(result);
  if (!isNonEmptyString(taskId) || !isTaskMetadata(metadata) || outcome === undefined)
    throw new Error("Invalid terminal workflow task view.");
  const registry = readRegistry(state);
  const runs = [...registry.runs];
  const index = runs.findIndex(
    (entry) => entry.lifetime === "session" && entry.task.taskId === taskId,
  );
  const entry = runs[index];
  if (entry === undefined || entry.lifetime !== "session") return state;
  if (!sameTaskMetadata(entry.task.metadata, metadata))
    throw new Error(`Task view metadata does not match invocation "${view.taskId}".`);
  const previous = readWorkflowTaskView(entry.task);
  // Parent delivery order decides settlement. Replays and late outcomes cannot replace it.
  if (previous !== undefined) return state;
  runs[index] = {
    ...entry,
    task: {
      ...entry.task,
      outcome,
    },
  };
  return writeRegistry(state, { ...registry, runs });
}

/** Removes only this turn's waiting calls. Session-owned task payloads are never pruned here. */
export function removeBlockingWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const registry = readRegistry(session.state);
  const entries = registry.runs;
  const remaining = entries.filter(
    (entry) =>
      entry.lifetime !== "turn" ||
      entry.origin.turnId !== turnId ||
      (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === entries.length
    ? session
    : { ...session, state: writeRegistry(session.state, { ...registry, runs: remaining }) };
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
  return record !== undefined && record.toolName === result.toolName;
}

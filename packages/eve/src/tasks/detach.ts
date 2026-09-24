import { sleep } from "#compiled/@workflow/core/index.js";

import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

// How an owner's turn treats the calls it waits on: which ones a steering
// message detaches or ends, and which `detach: { timeout }` timers race the
// inbox. Read by the session workflow body, so this module must not import
// Node.js built-ins.

/** What the owner decided about its waited calls when it started them. */
export interface TaskWaitPlan {
  /**
   * The turn is an interactive root turn: a root session in conversation
   * mode, in a turn a schedule did not start. Only there does a steering
   * message detach waited calls, and only there do `detach: { timeout }`
   * timers run.
   */
  readonly detachable: boolean;
  /** Waited calls to eve's `sleep` tool, which a steering message ends early in any session. */
  readonly sleepCallIds: readonly string[];
  /** Waited `detach: { timeout }` calls and their timeouts in milliseconds; empty unless detachable. */
  readonly timeouts: readonly { readonly callId: string; readonly timeoutMs: number }[];
}

/**
 * How long a call whose question a steering message dismissed may keep the
 * turn waiting. A call that is still working then detaches with the calls
 * the message detached, so the model sees the message without waiting on it.
 */
export const DISMISSED_CALL_GRACE_MS = 10_000;

/** What interrupted a foreground wait. */
export type WaitInterruption =
  | {
      /** A steering message; tasks whose dismissible question it dismissed keep waiting for now. */
      readonly kind: "steer";
      readonly dismissedTaskIds: readonly string[];
    }
  /** A `detach: { timeout }` timer, or the grace period of a dismissed call. */
  | { readonly kind: "timeout"; readonly callId: string };

/** The table changes one interruption makes. */
export interface WaitedTaskChanges {
  readonly reason: "steer" | "timeout";
  /** Waited calls whose tasks move to the background. */
  readonly detachCallIds: readonly string[];
  /** Waited `sleep` calls that end early; their runs are cancelled. */
  readonly endCallIds: readonly string[];
  /** Tasks that keep their call waiting, because the message dismissed their question. */
  readonly keepTaskIds: readonly string[];
  /**
   * The call whose ID names a steering message's detach group, so a
   * dismissed call that detaches after its grace period joins the same group.
   */
  readonly groupCallId?: string;
}

const SLEEP_WORKFLOW_FUNCTION = "executeSleepTool";

/**
 * Whether a workflow ID names eve's own `sleep` tool. The build names a
 * workflow after the module that defines it: the eve package
 * (`eve@<version>`), or eve's source tree when eve itself is under test.
 * Ending early on steer is internal to that tool, not an authored option.
 */
export function isSleepToolWorkflowId(workflowId: string): boolean {
  const prefix = "workflow//";
  const suffix = `//${SLEEP_WORKFLOW_FUNCTION}`;
  if (!workflowId.startsWith(prefix) || !workflowId.endsWith(suffix)) return false;
  const source = workflowId.slice(prefix.length, -suffix.length);
  return (
    source === "eve" ||
    source.startsWith("eve@") ||
    source.startsWith("eve/") ||
    source.endsWith("src/execution/tools/sleep-workflow")
  );
}

/** Decides how the turn treats the calls of one coordination batch. */
export function planTaskWait(input: {
  readonly detachable: boolean;
  readonly requests: readonly Pick<
    RuntimeWorkflowTaskRequest,
    "callId" | "detach" | "workflowId"
  >[];
}): TaskWaitPlan {
  const sleepCallIds: string[] = [];
  const timeouts: { callId: string; timeoutMs: number }[] = [];
  for (const request of input.requests) {
    if (isSleepToolWorkflowId(request.workflowId)) {
      sleepCallIds.push(request.callId);
    } else if (input.detachable && typeof request.detach === "object") {
      timeouts.push({ callId: request.callId, timeoutMs: request.detach.timeout });
    }
  }
  return { detachable: input.detachable, sleepCallIds, timeouts };
}

/** Whether a steering message can change anything about this wait. */
export function steeringInterruptsWait(plan: TaskWaitPlan): boolean {
  return plan.detachable || plan.sleepCallIds.length > 0;
}

/**
 * The changes one interruption makes to the calls still waiting, or
 * `undefined` when it changes nothing. A steering message ends waited
 * sleeps in any session and, in an interactive root turn, detaches every
 * other waited call together. A timer detaches only its own call.
 */
export function resolveWaitInterruption(input: {
  /** Dismissed calls still in their grace period, mapped to their group's call ID. */
  readonly dismissed?: ReadonlyMap<string, string>;
  readonly interruption: WaitInterruption;
  readonly plan: TaskWaitPlan;
  readonly unresolvedCallIds: readonly string[];
}): WaitedTaskChanges | undefined {
  const { interruption, plan, unresolvedCallIds } = input;
  if (interruption.kind === "timeout") {
    const { callId } = interruption;
    if (!plan.detachable || !unresolvedCallIds.includes(callId)) return undefined;
    const groupCallId = input.dismissed?.get(callId);
    return groupCallId === undefined
      ? { detachCallIds: [callId], endCallIds: [], keepTaskIds: [], reason: "timeout" }
      : { detachCallIds: [callId], endCallIds: [], groupCallId, keepTaskIds: [], reason: "steer" };
  }
  const endCallIds = unresolvedCallIds.filter((callId) => plan.sleepCallIds.includes(callId));
  const detachCallIds = plan.detachable
    ? unresolvedCallIds.filter((callId) => !endCallIds.includes(callId))
    : [];
  if (endCallIds.length === 0 && detachCallIds.length === 0) return undefined;
  const changes: { -readonly [K in keyof WaitedTaskChanges]: WaitedTaskChanges[K] } = {
    detachCallIds,
    endCallIds,
    keepTaskIds: interruption.dismissedTaskIds,
    reason: "steer",
  };
  const [groupCallId] = detachCallIds;
  if (groupCallId !== undefined) changes.groupCallId = groupCallId;
  return changes;
}

/**
 * The timers of one foreground wait: one durable sleep per timed call,
 * started with the wait, plus the grace period of each dismissed call. A
 * timer still pending when the wait ends is abandoned: it no longer affects
 * the turn, though its durable sleep may still wake the run once when it
 * elapses.
 */
export class DetachTimers {
  readonly #armed: Map<string, Promise<string>>;

  constructor(timeouts: TaskWaitPlan["timeouts"]) {
    this.#armed = new Map(
      timeouts.map(({ callId, timeoutMs }) => [callId, sleep(timeoutMs).then(() => callId)]),
    );
  }

  /** Starts a timer for one call, replacing any timer it already had. */
  arm(callId: string, ms: number): void {
    this.#armed.set(
      callId,
      sleep(ms).then(() => callId),
    );
  }

  /** Resolves with the call ID of the next timer to fire, or is `undefined` when none is armed. */
  next(): Promise<string> | undefined {
    return this.#armed.size === 0 ? undefined : Promise.race(this.#armed.values());
  }

  /** Stops racing the timers of calls that resolved or already detached. */
  disarm(callIds: Iterable<string>): void {
    for (const callId of callIds) this.#armed.delete(callId);
  }
}

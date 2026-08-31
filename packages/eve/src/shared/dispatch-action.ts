import type { JsonObject } from "#shared/json.js";
import type { PreparedDispatchTarget } from "#tools/behavior.js";

/** One model tool call selected for durable execution outside the harness. */
export interface PendingDispatchAction {
  readonly callId: string;
  readonly description: string;
  readonly input: JsonObject;
  readonly target: PreparedDispatchTarget;
  readonly toolName: string;
}

/** Pending action that delegates work to a prepared agent identity. */
export type PendingAgentDispatchAction = PendingDispatchAction & {
  readonly target: Extract<
    PreparedDispatchTarget,
    { readonly kind: "remote-agent-call" | "self-agent-call" | "subagent-call" }
  >;
};

/** Pending action that mutates the durable task lifecycle. */
export type PendingTaskControlAction = PendingDispatchAction & {
  readonly target: Extract<
    PreparedDispatchTarget,
    { readonly kind: "task-cancel" | "task-update" }
  >;
};

/** Fields common to task-control dispatch and its result projection helpers. */
export type TaskControlInvocation = Pick<PendingDispatchAction, "callId" | "input" | "toolName">;

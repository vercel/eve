import type { ReplyTarget } from "#execution/inbox/types.js";

/**
 * Durable state for the subagent adapter, split from the adapter itself so
 * harness code can identify a delegated child run without reaching the
 * adapter's workflow-coupled behavior (`runtime-boundary.test.ts`).
 */

/**
 * Durable adapter kind used for delegated subagent child runs.
 *
 * Framework-owned — authored channel code never constructs a subagent
 * adapter directly. Emitted by `buildSubagentRunInput`
 * (`execution/subagent-tool.ts`) when a parent dispatches a child
 * subagent.
 */
export const SUBAGENT_ADAPTER_KIND = "subagent";

/**
 * Durable state carried on a subagent adapter instance.
 *
 * Populated by `buildSubagentRunInput` at dispatch time so the child
 * run retains the parent lineage metadata required to resume its parent
 * when the child finishes and to forward HITL requests up the chain.
 *
 * The parent's turn identifier is not duplicated here — it lives on
 * `RunInput.parent.turn.id` which is the single source of truth for the
 * child's parent-turn lineage.
 */
export interface SubagentAdapterState extends Record<string, unknown> {
  readonly callId: string;
  readonly parentReplyTo: ReplyTarget;
  readonly parentSessionId: string;
  readonly subagentName: string;
  /** Owning task when this child was started by a background workflow tool. */
  readonly taskId?: string;
}

/**
 * Narrow runtime guard for {@link SubagentAdapterState}.
 *
 * Framework adapters live through a JSON round-trip at every workflow
 * step boundary, so consumers that want to treat the adapter state as
 * a structured record must validate the shape explicitly.
 */
export function isSubagentAdapterState(value: unknown): value is SubagentAdapterState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<SubagentAdapterState>;

  return (
    typeof state.callId === "string" &&
    state.callId.length > 0 &&
    isReplyTarget(state.parentReplyTo) &&
    typeof state.parentSessionId === "string" &&
    typeof state.subagentName === "string" &&
    state.subagentName.length > 0 &&
    (state.taskId === undefined || (typeof state.taskId === "string" && state.taskId.length > 0))
  );
}

function isReplyTarget(value: unknown): value is ReplyTarget {
  if (value === null || typeof value !== "object") return false;
  const target = value as Partial<ReplyTarget>;
  if (target.kind === "session") return typeof target.token === "string" && target.token.length > 0;
  return (
    target.kind === "inbox" &&
    typeof target.requestId === "string" &&
    target.requestId.length > 0 &&
    target.address !== undefined &&
    typeof target.address.token === "string" &&
    target.address.token.length > 0 &&
    typeof target.address.ownerRunId === "string" &&
    target.address.ownerRunId.length > 0
  );
}

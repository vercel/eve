import type { MessageStreamEvent } from "eve/client";

/**
 * Every write tool the `github` extension mounts, namespaced as the model
 * sees them.
 *
 * @remarks
 * Read-only evals assert `notCalledTool` over this whole list rather than
 * naming the one tool a bad run might reach for, so a new write tool added to
 * the extension is automatically forbidden in every read-only eval until
 * someone allows it deliberately. Keep in sync with the `include` list in
 * `agent/extensions/github.ts`.
 */
export const GITHUB_WRITE_TOOLS = [
  "github__addAssignees",
  "github__addIssueComment",
  "github__addLabels",
  "github__addPullRequestComment",
  "github__closeIssue",
  "github__createIssue",
  "github__createPullRequest",
  "github__removeAssignees",
  "github__removeLabel",
  "github__requestReviewers",
  "github__updateIssue",
  "github__updatePullRequest",
] as const;

/**
 * Root-mounted write tools (not part of the `github` extension).
 *
 * @remarks
 * Read-only evals assert `notCalledTool` over this list alongside
 * {@link GITHUB_WRITE_TOOLS}, so a read-only turn that reaches for the shared
 * factory brain fails. `read_factory_brain` and `read_artifact` are
 * deliberately absent: reading the brain or a handoff artifact is always
 * allowed. The station-side `save_artifact` never mounts on the root, so it
 * does not belong here either.
 */
export const ROOT_WRITE_TOOLS = ["update_factory_brain"] as const;

/**
 * Every write tool the model can reach, extension and root alike.
 */
export const WRITE_TOOLS = [
  ...GITHUB_WRITE_TOOLS,
  ...ROOT_WRITE_TOOLS,
] as const;

/**
 * The four factory stations, in pipeline order.
 */
export const STATIONS = [
  "classifier",
  "analyst",
  "implementer",
  "reviewer",
] as const;

/**
 * Returns the order in which subagents were first delegated to during a run,
 * extracted from `subagent.called` stream events.
 *
 * @remarks
 * Station delegations are subagent calls, not tool calls, so ordering
 * assertions walk the subagent events rather than `t.toolOrder`.
 */
export function subagentCallOrder(
  events: readonly MessageStreamEvent[]
): string[] {
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== "subagent.called") {
      continue;
    }
    const { name } = event.data as { name?: unknown };
    if (typeof name === "string" && !order.includes(name)) {
      order.push(name);
    }
  }
  return order;
}

/**
 * True when every named subagent was called and their first calls happened in
 * the given order (other calls may interleave).
 */
export function calledInOrder(
  events: readonly MessageStreamEvent[],
  names: readonly string[]
): boolean {
  const order = subagentCallOrder(events);
  const indices = names.map((name) => order.indexOf(name));
  return indices.every(
    (index, i) => index !== -1 && (i === 0 || index > (indices[i - 1] ?? -1))
  );
}

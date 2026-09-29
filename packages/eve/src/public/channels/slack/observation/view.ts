import type { ObservationState } from "#execution/run-observation/state.js";

export interface DesiredSlackObject {
  readonly key: string;
  readonly kind: "reply" | "activity" | "error";
  readonly text: string;
  readonly lifecycle: "retained" | "mutable";
}

export interface DesiredSlackView {
  readonly revision: number;
  readonly messages: readonly DesiredSlackObject[];
  readonly status: string;
}

/** A deterministic thread-only view for the controlled, noninteractive fixture. */
export function projectSlackObservation(state: ObservationState): DesiredSlackView {
  const root = state.sources[state.rootKey];
  if (root === undefined) throw new Error("Observation root source is missing.");
  const messages: DesiredSlackObject[] = Object.entries(root.completedReplies).map(
    ([id, reply]) => ({
      key: `${state.rootKey}:reply:${id}`,
      kind: "reply",
      text: reply.text,
      lifecycle: "retained",
    }),
  );
  for (const turn of Object.values(root.conversation.turns)) {
    const tasks = Object.values(root.conversation.tasks).flatMap((task) =>
      Object.values(task.calls)
        .filter((call) => call.turnId === turn.turnId)
        .map((call) => {
          const child = Object.values(root.conversation.agents).find(
            (agent) => agent.callId === call.callId,
          );
          const source =
            child === undefined
              ? undefined
              : state.sources[`${state.rootKey}/${call.callId}/${child.sessionId}`];
          const observation = source?.unavailable ? " (observation unavailable)" : "";
          const nested = state.sourceOrder.some(
            (key) =>
              state.sources[key]?.parentKey === source?.key && state.sources[key]?.unsupported,
          )
            ? " (nested descendants unsupported)"
            : "";
          return `${escapeSlackText(task.name)}: ${call.status}${observation}${nested}`;
        }),
    );
    if (tasks.length > 0) {
      messages.push({
        key: `${state.rootKey}:activity:${turn.turnId}`,
        kind: "activity",
        lifecycle: "mutable",
        text: tasks.join("\n"),
      });
    }
    if (turn.status === "failed" || turn.status === "cancelled") {
      messages.push({
        key: `${state.rootKey}:error:${turn.turnId}`,
        kind: "error",
        lifecycle: "retained",
        text: turn.status === "failed" ? "The run failed." : "The run was cancelled.",
      });
    }
  }
  if (
    state.terminalFailure &&
    !Object.values(root.conversation.turns).some((turn) => turn.status === "failed")
  ) {
    messages.push({
      key: `${state.rootKey}:error:session`,
      kind: "error",
      lifecycle: "retained",
      text: "The run failed.",
    });
  }
  const active = root.conversation.activeTurnId;
  return {
    revision: state.revision,
    messages,
    status: active === undefined ? "" : "Working…",
  };
}

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

import type { SessionStreamEvent } from "eve/client";
import type { EveEvalTurn } from "eve/evals";

import type { SubagentHookObservation } from "../subagent-hook-audit";

/** One observation as `read_subagent_hooks` returns it, with the sandbox file its hook wrote. */
export type AuditedHookObservation = SubagentHookObservation & {
  readonly sandboxCallId: string | null;
};

/** The observations the turn's `read_subagent_hooks` call read back from the parent session. */
export function readHookAudit(turn: EveEvalTurn): readonly AuditedHookObservation[] {
  const output = turn.toolCalls.find((call) => call.name === "read_subagent_hooks")?.output;
  if (!Array.isArray(output)) throw new Error("The recorded hook observations are missing.");
  return output as AuditedHookObservation[];
}

/** An event's position as the hooks record it. */
export function positionOf(event: SessionStreamEvent): string {
  return `${event.meta.position.line}:${event.meta.position.index}`;
}

/** The call that owns a `child.opened`, directly or through the task it opened in. */
function ownerCallId(
  events: readonly SessionStreamEvent[],
  owner: { readonly callId: string } | { readonly taskId: string },
): string | undefined {
  if ("callId" in owner) return owner.callId;
  const started = events.find(
    (event) => event.type === "task.started" && event.data.taskId === owner.taskId,
  );
  return started?.type === "task.started" ? started.data.startedBy.callId : undefined;
}

/**
 * Whether the typed and `*` hooks each recorded every `child.opened` in `events` exactly once,
 * in the parent session's state and sandbox, at the event's position.
 */
export function recordsEveryAgentStart(
  records: readonly AuditedHookObservation[],
  events: readonly SessionStreamEvent[],
  parentSessionId: string,
): boolean {
  const opens = events.flatMap((event) => (event.type === "child.opened" ? [event] : []));
  const recorded = records.filter((record) => record.type === "child.opened");
  return (
    opens.length > 0 &&
    recorded.length === opens.length * 2 &&
    opens.every((open) => {
      const callId = ownerCallId(events, open.data.owner);
      return (["typed", "wildcard"] as const).every(
        (subscriber) =>
          recorded.filter(
            (record) =>
              record.subscriber === subscriber &&
              record.position === positionOf(open) &&
              record.childSessionId === open.data.sessionId &&
              record.callId === callId &&
              record.sandboxCallId === callId &&
              record.sessionId === parentSessionId,
          ).length === 1,
      );
    })
  );
}

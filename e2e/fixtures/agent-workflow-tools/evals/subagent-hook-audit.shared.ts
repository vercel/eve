import type { MessageStreamEvent } from "eve/client";
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

/**
 * Whether the typed and `*` hooks each recorded every `agent.started` in
 * `events` exactly once, in the parent session's state and sandbox, under the
 * event's published ID.
 */
export function recordsEveryAgentStart(
  records: readonly AuditedHookObservation[],
  events: readonly MessageStreamEvent[],
  parentSessionId: string,
): boolean {
  const starts = events.flatMap((event) => (event.type === "agent.started" ? [event] : []));
  const recorded = records.filter((record) => record.type === "agent.started");
  return (
    starts.length > 0 &&
    recorded.length === starts.length * 2 &&
    starts.every((start) =>
      (["typed", "wildcard"] as const).every(
        (subscriber) =>
          recorded.filter(
            (record) =>
              record.subscriber === subscriber &&
              record.eventId === start.meta.id &&
              record.childSessionId === start.data.sessionId &&
              record.callId === start.data.callId &&
              record.sandboxCallId === start.data.callId &&
              record.sessionId === parentSessionId,
          ).length === 1,
      ),
    )
  );
}

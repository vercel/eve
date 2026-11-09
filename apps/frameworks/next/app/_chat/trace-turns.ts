import type { EveMessage, SessionStreamEvent } from "eve/client";

import { buildTraceTurnsFromTranscript } from "./trace";
import type { TraceStep, TraceTurn } from "./types";

/**
 * The trace's turns: each turn the session's events record, then each message this client sent
 * that eve hasn't consumed yet, which `data.messages` shows before the stream does.
 */
export function traceTurns(
  events: readonly SessionStreamEvent[],
  messages: readonly EveMessage[],
): readonly TraceTurn[] {
  const sent = messages.flatMap((message) =>
    message.metadata?.optimistic === true ? [clientMessageTurn(message)] : [],
  );
  return [...buildTraceTurnsFromTranscript(events), ...sent];
}

function clientMessageTurn(message: EveMessage): TraceTurn {
  const failed = message.metadata?.status === "failed";
  const steps = failed
    ? [
        {
          actionCount: 0,
          actions: [],
          errorMessage: "The message could not be sent.",
          events: [],
          status: "failed",
          stepIndex: 0,
          subagentCount: 0,
        } satisfies TraceStep,
      ]
    : [];

  return {
    events: [],
    status: failed ? "failed" : "running",
    steps,
    subagentCount: 0,
    turnId: `client:${message.id}`,
    userMessage: message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(""),
  };
}

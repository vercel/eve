import type { EveAgentReducer, EveAgentReducerEvent } from "eve/react";
import type { HandleMessageStreamEvent } from "eve/client";

import { buildTraceTurnsFromTranscript } from "./trace";
import type { TraceStep, TraceTurn, TranscriptStreamEvent } from "./types";

export interface TraceProjection {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly turns: readonly TraceTurn[];
}

export function traceReducer(): EveAgentReducer<TraceProjection> {
  return {
    initial() {
      return {
        events: [],
        turns: [],
      };
    },
    reduce(data, event) {
      return reduceTraceProjection(data, event);
    },
  };
}

function reduceTraceProjection(
  data: TraceProjection,
  event: EveAgentReducerEvent,
): TraceProjection {
  switch (event.type) {
    case "client.message.submitted":
      return {
        events: data.events,
        turns: [
          ...withoutClientMessageTurns(data.turns),
          createClientMessageTurn({
            message: event.data.message,
            status: "running",
            submissionId: event.data.submissionId,
          }),
        ],
      };

    case "client.message.failed":
      return {
        events: data.events,
        turns: [
          ...withoutClientMessageTurns(data.turns),
          createClientMessageTurn({
            errorMessage: event.data.error.message,
            message: event.data.message,
            status: "failed",
            submissionId: event.data.submissionId,
          }),
        ],
      };

    case "client.input.responded":
      return data;

    default: {
      const events = [...data.events, event];
      const turns = buildTraceTurnsFromEvents(events);
      return {
        events,
        turns:
          event.type === "message.received" ? turns : [...clientMessageTurns(data.turns), ...turns],
      };
    }
  }
}

function buildTraceTurnsFromEvents(
  events: readonly HandleMessageStreamEvent[],
): readonly TraceTurn[] {
  return buildTraceTurnsFromTranscript(events as readonly TranscriptStreamEvent[]);
}

function clientMessageTurns(turns: readonly TraceTurn[]): readonly TraceTurn[] {
  return turns.filter((turn) => turn.turnId.startsWith("client:"));
}

function withoutClientMessageTurns(turns: readonly TraceTurn[]): readonly TraceTurn[] {
  return turns.filter((turn) => !turn.turnId.startsWith("client:"));
}

function createClientMessageTurn(input: {
  readonly errorMessage?: string;
  readonly message: string;
  readonly status: "failed" | "running";
  readonly submissionId: string;
}): TraceTurn {
  const steps =
    input.errorMessage === undefined
      ? []
      : [
          {
            actionCount: 0,
            actions: [],
            errorMessage: input.errorMessage,
            events: [],
            status: "failed",
            stepIndex: 0,
            subagentCount: 0,
          } satisfies TraceStep,
        ];

  return {
    events: [],
    status: input.status,
    steps,
    subagentCount: 0,
    turnId: `client:${input.submissionId}`,
    userMessage: input.message,
  };
}

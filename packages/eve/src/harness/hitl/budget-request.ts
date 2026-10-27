import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#shared/input.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { ResponseValue } from "#protocol/session-events/families/response.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface LimitAsk {
  readonly interactionId: string;
  readonly request: InteractionRequest;
}

export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  readonly turnSequence: number;
  readonly windowIndex: number;
}): LimitAsk {
  const { sessionId, turnSequence, windowIndex } = input;
  return {
    // Cost-only windows can advance without any token count changing.
    interactionId: `${sessionId}:${turnSequence}:limit:usage:${windowIndex}`,
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "budget",
      options: [
        {
          description: "Start a new usage window",
          id: APPROVE_OPTION_ID,
          label: "Approve",
          style: "primary",
        },
        { description: "Stop now", id: DENY_OPTION_ID, label: "Stop", style: "danger" },
      ],
      prompt:
        "This session has hit its usage limit. This is a guardrail against defective " +
        "long-running sessions. If session activity looks fine, just approve to keep going.",
    },
  };
}

export function toJsonUsage(usage: TokenUsage): JsonObject {
  const { costUsd, ...tokens } = usage;
  return costUsd === undefined ? tokens : { ...tokens, costUsd };
}

export function isSessionLimitContinuationRequestId(requestId: string): boolean {
  return (
    /:limit:(?:usage|input|output):\d+$/u.test(requestId) ||
    /:limit:token-cost:\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(requestId)
  );
}

export function limitDecision(answer: ResponseValue): { readonly granted: boolean } | undefined {
  if (answer.optionId === APPROVE_OPTION_ID) return { granted: true };
  if (answer.optionId === DENY_OPTION_ID) return { granted: false };
  return undefined;
}

/**
 * Limit reducer: a session-limit prompt. The complete rule set
 * for #1224's `owner.limit.*` requests.
 *
 * The one special case in the whole model lives here: a message
 * while a limit prompt is open is CONSUMED (its text never reaches the
 * model — the prompt exists to stop spend) and the prompt reopens at the
 * next generation. Stale generations never reach this reducer: generation
 * is part of the request id, so a gen-1 response hits a retained terminal request and is
 * rejected interpreter-side — with "drop" visibility, the one request kind for
 * which a stale answer must not produce a context turn.
 */

import type { InputRequest } from "../harness-types.js";
import type { RequestReducer, Verdict } from "../types.js";

export interface LimitSpec {
  readonly request: InputRequest; // kind: "session-limit"
  readonly generation: number;
}

export type LimitOutcome = "continued" | "stopped";

export const limit: RequestReducer<LimitSpec, LimitOutcome> = {
  staleResponses: "drop",

  resolve(request, input): Verdict<LimitOutcome> {
    switch (input.kind) {
      case "response":
        return { settle: input.response.optionId === "continue" ? "continued" : "stopped" };
      case "message":
        return {
          dismiss: "superseded",
          reopen: { ...request.spec, generation: request.spec.generation + 1 },
          consumeDelivery: true,
        };
      default:
        return "ignore";
    }
  },
};

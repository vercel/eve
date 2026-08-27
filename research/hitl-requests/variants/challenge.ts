/**
 * Challenge variant: a connection-authorization challenge (OAuth
 * credentials, not consent). The complete rule set for #1224's
 * `owner.auth.*` rows.
 *
 * Challenges keep the `authorization.*` event names; the interpreter
 * translates a forced dismissal to `completed(cancelled)` — the one place
 * kind leaks into interpreter output. Deadlines are interpreter-scheduled
 * from `deadlineAt`; the reducer only ever sees them as inputs.
 */

import type { Variant, Verdict } from "../types.js";

export interface ChallengeSpec {
  readonly name: string; // connection name
  readonly attemptId: string;
  readonly hookUrl: string; // OAuth callback target
  readonly deadlineAt?: number;
}

export type ChallengeOutcome = "authorized" | "declined" | "failed" | "timed-out";

export const challenge: Variant<ChallengeSpec, ChallengeOutcome> = {
  resolve(_row, input): Verdict<ChallengeOutcome> {
    switch (input.kind) {
      case "callback": {
        const outcome = input.params["outcome"];
        return {
          settle: outcome === "authorized" || outcome === "declined" ? outcome : "failed",
        };
      }
      case "deadline":
        return { settle: "timed-out" };
      default:
        return "ignore"; // messages never touch an open challenge
    }
  },
};

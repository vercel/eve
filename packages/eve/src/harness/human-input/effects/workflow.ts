import type { HumanInputEnding } from "./session.js";

// How the session workflow body reaches human input: it carries out how human
// input ended a turn.

/**
 * The session fails with the code human input gave. Thrown from the session
 * workflow, not a step, so it is not retried; the session reports it as its
 * terminal `session.failed`.
 */
export class HumanInputFailure extends Error {
  constructor(ending: Extract<HumanInputEnding, { readonly kind: "failed" }>) {
    super(ending.message);
    this.name = ending.code;
  }
}

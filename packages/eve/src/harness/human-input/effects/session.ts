import type { HumanInputEvent } from "#harness/human-input/index.js";
import type { HandleEventFn } from "#harness/types.js";

/** How human input ended the turn, for the session workflow to carry out. */
export type HumanInputEnding =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/**
 * Applies what human input reported to a session step outside the harness:
 * a cancel, or a request a workflow run relays. Each event has one meaning
 * here. Returns how the turn ended, when an event ended it; the session
 * workflow carries that out once the step commits.
 */
export async function applyHumanInputEvents(
  emit: HandleEventFn,
  events: readonly HumanInputEvent[],
): Promise<HumanInputEnding | undefined> {
  let ending: HumanInputEnding | undefined;
  for (const event of events) {
    switch (event.type) {
      case "publish":
        await emit(event.event);
        continue;
      case "turn.cancelled":
        ending ??= { kind: "cancelled" };
        continue;
      case "turn.failed":
        ending ??= { code: event.code, kind: "failed", message: event.message };
        continue;
      case "history.appended":
      case "note":
      case "calls.approved":
      case "responder.check":
      case "answer.forwarded":
      case "budget.granted":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return ending;
}

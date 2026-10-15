import { INACTIVE_PROMPT_RESOLUTION, resolvedPromptLabel } from "#channel/resolved-prompt.js";
import { isUnanswerableResponseError } from "#channel/session-not-active-error.js";
import type { Logger } from "#internal/logging.js";

/** What a channel tells the person whose answer can never be taken. */
export const INACTIVE_REQUEST_NOTICE =
  "This request is no longer active. Send a new message to start again.";

/** How one channel retires a prompt that a press found no session for. */
export interface InactivePromptRetirement {
  /**
   * Edits the pressed prompt the way the channel shows a resolved one: its
   * prompt kept, its choices replaced by `label`.
   */
  readonly retirePrompt: (label: string) => Promise<void>;
  /** Tells only the person who pressed, such as with an ephemeral message. */
  readonly notifyPresser: (notice: string) => Promise<void>;
}

/** What became of a person's answer to a prompt. */
export type PromptResponseOutcome =
  /** A session took the answer. */
  | "delivered"
  /** No session can ever take it; the prompt was retired and the presser told. */
  | "inactive"
  /** Delivery failed in a way a retry may fix; the prompt is left as it was. */
  | "failed";

/**
 * Delivers a person's answer to a prompt and reports what became of it.
 *
 * When no session can ever take the answer, such as after the session's run
 * was cancelled outside eve, nothing will withdraw the prompt either, so it is
 * retired here as a resolved prompt labeled `No longer active`, and the person
 * who answered is told. The edit and the notice start together, so a slow edit
 * never holds up the notice. Any other failure is only logged and leaves the
 * prompt as it was, since a retry may succeed.
 */
export async function respondOrRetireInactivePrompt(
  respond: () => Promise<unknown>,
  retirement: InactivePromptRetirement,
  log: Logger,
): Promise<PromptResponseOutcome> {
  try {
    await respond();
    return "delivered";
  } catch (error) {
    if (!isUnanswerableResponseError(error)) {
      log.error("input response delivery failed", { error });
      return "failed";
    }
    log.warn("input response reached no active session", { error });
  }
  await Promise.all([
    retirement
      .retirePrompt(resolvedPromptLabel(INACTIVE_PROMPT_RESOLUTION))
      .catch((error: unknown) => log.error("inactive prompt edit failed", { error })),
    retirement
      .notifyPresser(INACTIVE_REQUEST_NOTICE)
      .catch((error: unknown) => log.error("inactive prompt notice failed", { error })),
  ]);
  return "inactive";
}

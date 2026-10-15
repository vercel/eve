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

/**
 * Delivers a person's answer to a prompt and returns whether it was delivered.
 *
 * When no session can ever take the answer, such as after the session's run
 * was cancelled outside eve, nothing will withdraw the prompt either, so it is
 * retired here as a resolved prompt labeled `No longer active`, and the person
 * who answered is told. Any other failure is only logged and leaves the prompt
 * as it was, since a retry may succeed.
 */
export async function respondOrRetireInactivePrompt(
  respond: () => Promise<unknown>,
  retirement: InactivePromptRetirement,
  log: Logger,
): Promise<boolean> {
  try {
    await respond();
    return true;
  } catch (error) {
    if (!isUnanswerableResponseError(error)) {
      log.error("input response delivery failed", { error });
      return false;
    }
    log.warn("input response reached no active session", { error });
  }
  try {
    await retirement.retirePrompt(resolvedPromptLabel(INACTIVE_PROMPT_RESOLUTION));
  } catch (error) {
    log.error("inactive prompt edit failed", { error });
  }
  try {
    await retirement.notifyPresser(INACTIVE_REQUEST_NOTICE);
  } catch (error) {
    log.error("inactive prompt notice failed", { error });
  }
  return false;
}

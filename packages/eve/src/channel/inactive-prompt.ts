import { isUnanswerableResponseError } from "#channel/session-not-active-error.js";
import type { Logger } from "#internal/logging.js";

/** What a channel tells the person whose answer can never be taken. */
export const INACTIVE_REQUEST_NOTICE =
  "This request is no longer active. Send a new message to start again.";

/** The label a retired prompt shows in place of its choices. */
export const INACTIVE_PROMPT_LABEL = "No longer active";

/** How one channel retires a prompt that a press found no session for. */
export interface InactivePromptRetirement {
  /**
   * Edits the pressed prompt the way the channel shows a resolved one: its
   * prompt kept, its choices replaced by `label`.
   */
  readonly retirePrompt: (label: string) => Promise<void>;
  /** Keeps the request alive until the edit settles, without waiting on it. */
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/** What became of a person's answer to a prompt. */
export type PromptResponseOutcome =
  /** A session took the answer. */
  | "delivered"
  /** No session can ever take it; the prompt is being retired. */
  | "inactive"
  /** Delivery failed in a way a retry may fix; the prompt is left as it was. */
  | "failed";

/**
 * Delivers a person's answer to a prompt and reports what became of it.
 *
 * When no session can ever take the answer, such as after the session's run
 * was cancelled outside eve, nothing will withdraw the prompt either, so its
 * retirement starts here, labeled `No longer active`, and is left to
 * `waitUntil`. The caller tells the presser on `inactive` in whatever way its
 * platform allows, which never waits on the edit. Any other failure is only
 * logged and leaves the prompt as it was, since a retry may succeed.
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
  retirement.waitUntil(
    retirement
      .retirePrompt(INACTIVE_PROMPT_LABEL)
      .catch((error: unknown) => log.error("inactive prompt edit failed", { error })),
  );
  return "inactive";
}

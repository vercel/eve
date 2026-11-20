import { isUnanswerableResponseError } from "#channel/session-not-active-error.js";
import type { Logger } from "#internal/logging.js";

export const INACTIVE_REQUEST_NOTICE =
  "This request is no longer active. Send a new message to start again.";

export const INACTIVE_PROMPT_LABEL = "No longer active";

export interface InactivePromptRetirement {
  readonly retirePrompt: (label: string) => Promise<void>;
}

export type PromptResponse =
  | { readonly outcome: "delivered" }
  | { readonly outcome: "failed"; readonly error: unknown }
  | { readonly outcome: "inactive"; readonly retirement: Promise<void> };

export async function respondOrRetireInactivePrompt(
  respond: () => Promise<unknown>,
  retirement: InactivePromptRetirement,
  log: Logger,
): Promise<PromptResponse> {
  try {
    await respond();
    return { outcome: "delivered" };
  } catch (error) {
    if (!isUnanswerableResponseError(error)) {
      log.error("input response delivery failed", { error });
      return { outcome: "failed", error };
    }
    log.warn("input response reached no active session", { error });
  }
  return {
    outcome: "inactive",
    retirement: retirement
      .retirePrompt(INACTIVE_PROMPT_LABEL)
      .catch((error: unknown) => log.error("inactive prompt edit failed", { error })),
  };
}

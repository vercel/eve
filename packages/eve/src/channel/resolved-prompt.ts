import type { InputResolution } from "#protocol/message.js";
import type { InputOption } from "#shared/input.js";

type PromptOption = Pick<InputOption, "id" | "label">;

/**
 * How a posted prompt ended: a resolution eve accepted, or `inactive` when a
 * person answered a prompt no session holds anymore, such as after its run was
 * cancelled outside eve. Nothing will ever take that answer or withdraw the
 * prompt, so the channel retires it itself.
 */
export type PromptResolution =
  | Pick<InputResolution, "outcome" | "response">
  | { readonly outcome: "inactive" };

/** The resolution a channel renders when a press reached no active session. */
export const INACTIVE_PROMPT_RESOLUTION: PromptResolution = { outcome: "inactive" };

/**
 * How eve resolved a posted prompt, such as `Approved` or a chosen option's
 * label. A request that ends without an answer, such as one withdrawn when its
 * turn is cancelled, is no longer needed; one whose session is gone is no
 * longer active.
 */
export function resolvedPromptAnswer(
  resolution: PromptResolution,
  options: readonly PromptOption[] = [],
): string | undefined {
  switch (resolution.outcome) {
    case "approved":
      return "Approved";
    case "denied":
      return "Cancelled";
    case "answered": {
      const response = resolution.response;
      return options.find((option) => option.id === response?.optionId)?.label ?? response?.text;
    }
    case "inactive":
      return "No longer active";
    default:
      return "No longer needed";
  }
}

/** The line a prompt shows once resolved, such as `Approved` or `Answered: Saturday`. */
export function resolvedPromptLabel(
  resolution: PromptResolution,
  options: readonly PromptOption[] = [],
): string {
  const answer = resolvedPromptAnswer(resolution, options);
  if (resolution.outcome === "answered") {
    return answer === undefined ? "Answered" : `Answered: ${answer}`;
  }
  return answer ?? "";
}

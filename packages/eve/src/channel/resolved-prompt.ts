import type { InputResolution } from "#protocol/message.js";
import type { InputOption } from "#shared/input.js";

type PromptOption = Pick<InputOption, "id" | "label">;

/**
 * How eve resolved a posted prompt, such as `Approved` or a chosen option's
 * label. A request that ends without an answer, such as one withdrawn when its
 * turn is cancelled, is no longer needed.
 */
export function resolvedPromptAnswer(
  resolution: InputResolution,
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
    default:
      return "No longer needed";
  }
}

/** The line a prompt shows once resolved, such as `Approved` or `Answered: Saturday`. */
export function resolvedPromptLabel(
  resolution: InputResolution,
  options: readonly PromptOption[] = [],
): string {
  const answer = resolvedPromptAnswer(resolution, options);
  if (resolution.outcome === "answered") {
    return answer === undefined ? "Answered" : `Answered: ${answer}`;
  }
  return answer ?? "";
}

import type { RequestSettlement } from "#channel/interaction-prompts.js";
import type { InteractionOption } from "#protocol/session-events/families/interaction.js";

type PromptOption = Pick<InteractionOption, "id" | "label">;

/**
 * How eve resolved a posted prompt, such as `Approved` or a chosen option's
 * label. A request that ends without an answer, such as one withdrawn when its
 * turn is cancelled, is no longer needed.
 */
export function resolvedPromptAnswer(
  resolution: RequestSettlement,
  options: readonly PromptOption[] = [],
): string | undefined {
  const decided = resolution.outcome === "accepted" || resolution.outcome === "declined";
  if (!decided) return "No longer needed";
  if (resolution.kind === "approval") {
    return resolution.outcome === "accepted" ? "Approved" : "Cancelled";
  }
  const { answer } = resolution;
  return options.find((option) => option.id === answer?.optionId)?.label ?? answer?.text;
}

/** The line a prompt shows once resolved, such as `Approved` or `Answered: Saturday`. */
export function resolvedPromptLabel(
  resolution: RequestSettlement,
  options: readonly PromptOption[] = [],
): string {
  const answer = resolvedPromptAnswer(resolution, options);
  if (isAnswered(resolution)) {
    return answer === undefined ? "Answered" : `Answered: ${answer}`;
  }
  return answer ?? "";
}

/** A question or budget prompt someone answered. */
export function isAnswered(resolution: RequestSettlement): boolean {
  return (
    resolution.kind !== "approval" &&
    (resolution.outcome === "accepted" || resolution.outcome === "declined")
  );
}

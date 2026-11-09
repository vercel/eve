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

/**
 * The line a prompt shows once resolved, such as `Approved` or `Answered: Saturday`. `by` names
 * who gave the deciding answer, as in `Approved by Alice` or `Answered by Alice: Saturday`.
 */
export function resolvedPromptLabel(
  resolution: RequestSettlement,
  options: readonly PromptOption[] = [],
  by?: string,
): string {
  const answer = resolvedPromptAnswer(resolution, options);
  const decided = resolution.outcome === "accepted" || resolution.outcome === "declined";
  const named = by === undefined || by === "" || !decided ? "" : ` by ${by}`;
  if (isAnswered(resolution)) {
    return answer === undefined ? `Answered${named}` : `Answered${named}: ${answer}`;
  }
  return answer === undefined ? "" : `${answer}${named}`;
}

/**
 * The name a channel recorded for whoever gave a settlement's deciding answer, from the names it
 * keeps by principal id as people send messages and press buttons.
 */
export function responderName(
  names: Readonly<Record<string, string>> | undefined,
  resolution: RequestSettlement,
): string | undefined {
  const id = resolution.responder?.id;
  return id === undefined ? undefined : names?.[id];
}

/** A question or budget prompt someone answered. */
export function isAnswered(resolution: RequestSettlement): boolean {
  return (
    resolution.kind !== "approval" &&
    (resolution.outcome === "accepted" || resolution.outcome === "declined")
  );
}

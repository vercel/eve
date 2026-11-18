import type { RequestSettlement } from "#channel/interaction-prompts.js";
import type { InteractionOption } from "#protocol/session-events/families/interaction.js";

type PromptOption = Pick<InteractionOption, "id" | "label">;

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

export function responderName(
  names: Readonly<Record<string, string>> | undefined,
  resolution: RequestSettlement,
): string | undefined {
  const id = resolution.responder?.id;
  return id === undefined ? undefined : names?.[id];
}

export function isAnswered(resolution: RequestSettlement): boolean {
  return (
    resolution.kind !== "approval" &&
    (resolution.outcome === "accepted" || resolution.outcome === "declined")
  );
}

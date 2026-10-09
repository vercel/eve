/**
 * Why one model run ended. `tool-calls` is the only one the turn continues after, unless
 * steering superseded the run, which ends `other` and continues with the next run. The wire
 * carries it as an open string on `model.settled`.
 */
export type AssistantStepFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

/** Maps an AI SDK finish reason to the eve-owned union. */
export function normalizeAssistantStepFinishReason(
  value: string | undefined,
): AssistantStepFinishReason {
  switch (value) {
    case "content-filter":
    case "error":
    case "length":
    case "stop":
    case "tool-calls":
      return value;
    default:
      return "other";
  }
}

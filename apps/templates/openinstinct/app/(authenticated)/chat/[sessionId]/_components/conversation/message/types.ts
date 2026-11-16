import type { Answer } from "eve/events";

export type RespondToAgentInput = (
  answers: readonly Answer[]
) => void | Promise<void>;

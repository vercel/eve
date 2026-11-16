// Gateway model ids stay centralized so the implementer and reviewer remain
// on different vendors for independent review.
export const MODELS = {
  analyst: "openai/gpt-6.1-terra-fast",
  classifier: "openai/gpt-6.1-terra-fast",
  decision: "google/gemini-decision-1",
  implementer: "anthropic/claude-fable-5.2",
  orchestrator: "anthropic/claude-fable-5.2",
  researcher: "anthropic/claude-opus-5.5",
  reviewer: "openai/gpt-6.1-sol-fast",
} as const;

export type FactoryModel = keyof typeof MODELS;
export type FactoryAgent = Exclude<FactoryModel, "decision">;

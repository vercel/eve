import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import { mockModel } from "eve/evals";

const ACTIVE_TURN_DELAY_MS = 1_500;

const agent: DefinedAgent = defineAgent({
  // Harness config wires the workflow world; the model is always this
  // fixture's scripted mock.
  ...e2eAgentConfig(),
  model: mockModel(async ({ lastUserMessage }) => {
    if (lastUserMessage?.includes("SLOW-TURN") === true) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_TURN_DELAY_MS));
    }

    return `timeout-ack:${lastUserMessage ?? ""}`;
  }),
  modelContextWindowTokens: 1_000_000,
  limits: {
    sessionTimeoutMs: 750,
  },
});

export default agent;

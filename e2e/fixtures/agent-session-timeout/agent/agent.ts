import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const ACTIVE_TURN_DELAY_MS = 1_500;
const harness = e2eAgentConfig();

export default defineAgent({
  // Harness config wires the workflow world; the model is always this
  // fixture's scripted mock.
  ...harness,
  // The threads channel has no public audience, so outside development its
  // run data would be deleted at expiry and the replacement could not link it.
  experimental: { workflow: { ...harness.experimental?.workflow, retention: "default" } },
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

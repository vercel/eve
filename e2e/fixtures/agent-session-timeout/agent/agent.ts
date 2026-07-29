import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const ACTIVE_TURN_DELAY_MS = 1_500;

export default defineAgent({
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

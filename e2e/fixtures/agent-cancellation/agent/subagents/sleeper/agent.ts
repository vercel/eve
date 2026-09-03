import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const RECOVERY_TOKEN = "CANCELLED-SUBAGENT-RECOVERED";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled, then supports a recovery probe.",
  ...e2eSubagentConfig(),
  model: mockModel(({ lastUserMessage }) =>
    lastUserMessage?.includes(RECOVERY_TOKEN) === true
      ? RECOVERY_TOKEN
      : {
          toolCalls: [
            {
              id: "wait-for-cancellation",
              input: {},
              name: "wait-for-cancellation",
            },
          ],
        },
  ),
  modelContextWindowTokens: 1_000_000,
});

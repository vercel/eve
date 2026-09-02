import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const RECOVERY_TOKEN = "CANCELLED-SUBAGENT-RECOVERED";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled, then supports a recovery probe.",
  ...e2eSubagentConfig({
    mock: ({ lastUserMessage }) =>
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
  }),
});

import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const RECOVERY_REQUEST = "RESUME-CANCELLED-SLEEPER";
const RECOVERY_RESULT = "CANCELLED-SUBAGENT-RECOVERED";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled, then supports a recovery probe.",
  ...e2eSubagentConfig({
    mock: ({ lastUserMessage }) =>
      lastUserMessage?.includes(RECOVERY_REQUEST) === true
        ? RECOVERY_RESULT
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

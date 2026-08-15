import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const base = e2eAgentConfig({
  mock: ({ lastUserMessage }) =>
    lastUserMessage?.includes("Please wait for cancellation.") === true
      ? {
          toolCalls: [
            {
              id: "wait-for-cancellation",
              input: {},
              name: "wait-for-cancellation",
            },
          ],
        }
      : `Mock reply: ${lastUserMessage ?? ""}`,
});

export default defineAgent({
  ...base,
  // Persistent children keep the cancelled sleeper in the model-visible
  // [Agents] listing, which the cancel-subagent eval inspects after a
  // cascaded cancellation.
  experimental: { ...base.experimental, subagentPersistentSessions: true },
});

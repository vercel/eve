import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  // Harness config wires the workflow world; the model is always this
  // fixture's scripted mock.
  ...e2eAgentConfig(),
  model: mockModel(
    ({ lastUserMessage, userMessageCount }) =>
      // The private experiment marker is rendered as one ephemeral user-context message.
      `stress-ack:${userMessageCount - 1}:${lastUserMessage ?? ""}`,
  ),
  modelContextWindowTokens: 1_000_000,
});

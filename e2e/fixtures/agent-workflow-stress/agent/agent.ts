import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(
    ({ lastUserMessage, userMessageCount }) =>
      `stress-ack:${userMessageCount}:${lastUserMessage ?? ""}`,
  ),
  modelContextWindowTokens: 1_000_000,
});

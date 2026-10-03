import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const TOOL_NAME = "guarded-echo";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel(({ lastUserMessage, toolResults }) => {
    const result = toolResults.find((entry) => entry.name === TOOL_NAME);
    if (result !== undefined) return `APPROVAL-RESUME-OK:${JSON.stringify(result.output)}`;
    const marker = /marker "([^"]+)"/u.exec(lastUserMessage ?? "")?.[1];
    if (marker === undefined) return "APPROVAL-RESUME-MISSING-MARKER";
    return { toolCalls: [{ input: { marker }, name: TOOL_NAME }] };
  }),
  modelContextWindowTokens: 1_000_000,
});

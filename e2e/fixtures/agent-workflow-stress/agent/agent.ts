import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { FANOUT_LABELS, FANOUT_REPLY, FANOUT_TOOL_NAME } from "./lib/fanout";

export default defineAgent({
  // Harness config wires the workflow world; the model is always this
  // fixture's scripted mock.
  ...e2eAgentConfig(),
  model: mockModel((request) =>
    request.lastUserMessage?.includes(`\`${FANOUT_TOOL_NAME}\``)
      ? respondToFanout(request)
      : `stress-ack:${request.userMessageCount}:${request.lastUserMessage ?? ""}`,
  ),
  modelContextWindowTokens: 1_000_000,
});

function respondToFanout(request: MockModelRequest): MockModelResponse {
  const roles = request.messages.map((message) => message.role);
  if (roles.lastIndexOf("tool") > roles.lastIndexOf("user")) {
    return { text: FANOUT_REPLY };
  }
  return {
    toolCalls: FANOUT_LABELS.map((label) => ({ name: FANOUT_TOOL_NAME, input: { label } })),
  };
}

import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const transcript = JSON.stringify(request.messages);
  if (transcript.includes("CODEMODE:hello:1")) return "CODEMODE-RUN-COMPLETE";
  return {
    toolCalls: [
      {
        name: "code_mode",
        input: { js: 'return await tools.echo({ value: "hello" });' },
      },
    ],
  };
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, codeMode: true },
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});

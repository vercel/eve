import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const codeModeResult = [...request.toolResults]
    .reverse()
    .find((result) => result.name === "code_mode");

  if (message.includes("CODEMODE-TASK-LAUNCH")) {
    if (codeModeResult === undefined) {
      return {
        toolCalls: [
          {
            name: "code_mode",
            input: {
              js: 'return await tools["receipt-worker"]({ message: "CODEMODE-TASK-WORK" });',
            },
          },
        ],
      };
    }
    return `CODEMODE-TASK-RECEIPT:${JSON.stringify(codeModeResult.output)}`;
  }

  if (
    codeModeResult !== undefined &&
    typeof codeModeResult.output === "string" &&
    codeModeResult.output.startsWith("CODEMODE:hello:")
  ) {
    return "CODEMODE-RUN-COMPLETE";
  }
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
  experimental: { ...base.experimental, codeMode: true, tasks: true },
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});

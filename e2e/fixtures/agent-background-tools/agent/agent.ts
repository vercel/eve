import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const PROGRESS = "EXPORT-PROGRESS";
const RESULT = "EXPORT-COMPLETE";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";

  if (message.includes("BACKGROUND-EXPORT-START")) {
    return {
      toolCalls: [
        {
          name: "export",
          input: { query: "ship-it" },
        },
      ],
    };
  }

  if (message.includes(`update: ${PROGRESS}`)) {
    return "BACKGROUND-EXPORT-UPDATE-RECEIVED";
  }

  if (
    message.includes("is completed") &&
    (message.includes(RESULT) || message.includes("ship-it"))
  ) {
    return "BACKGROUND-EXPORT-DONE";
  }

  if (message.startsWith("Background task ")) {
    return "BACKGROUND-EXPORT-ACK";
  }

  return "BACKGROUND-EXPORT-IDLE";
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: {
    ...base.experimental,
    tasks: true,
  },
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});

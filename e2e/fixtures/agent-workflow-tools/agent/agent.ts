import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

/**
 * Deterministic script: each directive names the workflow tool to call with
 * service "api"; once the turn holds a tool result the reply echoes it.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";
  const roles = request.messages.map((entry) => entry.role);
  const turnHasToolResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");

  for (const [directive, tool] of [
    ["WORKFLOW-DEPLOY-START", "deploy_service"],
    ["WORKFLOW-CONFIRM-START", "confirm_deploy"],
    ["WORKFLOW-REPORT-START", "report_deploy"],
    ["WORKFLOW-ESCALATE-START", "escalate_deploy"],
    ["WORKFLOW-HOLD-START", "hold_deploy"],
    ["WORKFLOW-FANOUT-START", "fanout_deploy"],
  ] as const) {
    if (!message.includes(directive)) continue;
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { service: "api" }, name: tool }] };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === tool)?.output;
    return `${directive.replace("-START", "-RESULT")} ${
      typeof output === "string" ? output : JSON.stringify(output ?? null)
    }`;
  }

  if (message.includes("update: WORKFLOW-REPORT-PROGRESS")) {
    return "WORKFLOW-REPORT-UPDATE-RECEIVED";
  }
  if (message.includes("is completed") && message.includes("WORKFLOW-REPORT-COMPLETE")) {
    return "WORKFLOW-REPORT-DONE";
  }
  if (message.startsWith("Background task ")) {
    return "WORKFLOW-REPORT-ACK";
  }

  return "WORKFLOW-IDLE";
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

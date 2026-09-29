import { e2eAgentConfig } from "@eve-e2e/config";
import { latestTaskResult } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { respondToTaskScenario } from "./lib/task-scenarios.ts";

/**
 * Deterministic script: each directive names the workflow tool to call with
 * service "api"; once the turn holds a tool result the reply echoes it.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const hookScenario = request.userMessages.find((entry) => entry.includes("SUBAGENT-HOOKS:"));
  if (hookScenario !== undefined) {
    const auditing = request.lastUserMessage?.includes("SUBAGENT-HOOKS:AUDIT");
    const skillCallId = auditing ? "audit-policy" : "initial-policy";
    if (!request.toolResults.some((entry) => entry.id === skillCallId)) {
      return {
        toolCalls: [{ id: skillCallId, name: "load_skill", input: { skill: "delegation-policy" } }],
      };
    }
    const mode = /SUBAGENT-HOOKS:(direct|waiting)/u.exec(hookScenario)?.[1];
    if (auditing) {
      const auditTool = request.lastUserMessage?.includes("DYNAMIC-SKILL-CONTEXT")
        ? "read_dynamic_skill_context"
        : "read_subagent_hooks";
      const audit = request.toolResults.find((entry) => entry.name === auditTool);
      return audit === undefined
        ? { toolCalls: [{ name: auditTool, input: {} }] }
        : JSON.stringify(audit.output);
    }
    const tool = mode === "direct" ? "workflow-marker" : "blocking_agent";
    if (!request.toolResults.some((entry) => entry.name === tool)) {
      return {
        toolCalls: [
          {
            name: tool,
            input:
              mode === "direct" ? { message: "Alice's hook audit" } : { service: "hook-audit" },
          },
        ],
      };
    }
    // The agent call returned a receipt; its result arrives in a <task_result> message.
    if (mode === "direct") {
      return latestTaskResult(request, tool) ?? { toolCalls: [{ name: "task_wait", input: {} }] };
    }
    const result = request.toolResults.find((entry) => entry.name === tool);
    return typeof result?.output === "string" ? result.output : JSON.stringify(result?.output);
  }

  const message =
    [...request.userMessages]
      .reverse()
      .find((entry) => entry.startsWith("WORKFLOW-") || entry.includes("private-catalog")) ?? "";
  const scenario = respondToTaskScenario(request, directiveOf(message));
  if (scenario !== undefined) return scenario;
  if (message.includes("private-catalog")) {
    const result = request.toolResults.find((entry) => entry.name === "connection_search");
    if (result === undefined) {
      return {
        toolCalls: [
          {
            name: "connection_search",
            input: { connection: "private-catalog", keywords: "items" },
          },
        ],
      };
    }
    return JSON.stringify(result.output);
  }

  const stepAuth = /WORKFLOW-STEP-AUTH-(IMPLICIT|EXPLICIT|REJECTED)/u.exec(message);
  if (stepAuth !== null) {
    const result = request.toolResults.find((entry) => entry.name === "authorize_service");
    return result === undefined
      ? { toolCalls: [{ input: { service: stepAuth[1] }, name: "authorize_service" }] }
      : String(result.output);
  }
  const probe = /WORKFLOW-PROBE-blocking-local-(hitl|auth)/u.exec(message);
  if (probe !== null) {
    const result = request.toolResults.find((entry) => entry.name === "blocking_agent_probe");
    if (result === undefined) {
      return {
        toolCalls: [{ input: { kind: probe[1] }, name: "blocking_agent_probe" }],
      };
    }
    return `WORKFLOW-PROBE-RESULT ${String(result.output)}`;
  }
  for (const [directive, tool] of [
    ["WORKFLOW-DEPLOY-START", "deploy_service"],
    ["WORKFLOW-CONFIRM-START", "confirm_deploy"],
    ["WORKFLOW-ESCALATE-START", "escalate_deploy"],
    ["WORKFLOW-HOLD-START", "hold_deploy"],
    ["WORKFLOW-FANOUT-START", "fanout_deploy"],
    ["WORKFLOW-WEBHOOK-START", "webhook_deploy"],
    ["WORKFLOW-AGENT-FANOUT-START", "fanout_agents"],
  ] as const) {
    if (!message.includes(directive)) continue;
    const result = [...request.toolResults].reverse().find((entry) => entry.name === tool);
    if (result === undefined) {
      return { toolCalls: [{ input: { service: "api" }, name: tool }] };
    }
    const output = result.output;
    return `${directive.replace("-START", "-RESULT")} ${
      typeof output === "string" ? output : JSON.stringify(output ?? null)
    }`;
  }

  return "WORKFLOW-IDLE";
}

/** A directive is the first word of its message; any text after it is for people reading it. */
function directiveOf(message: string): string {
  return message.trim().split(/\s+/u)[0] ?? "";
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});

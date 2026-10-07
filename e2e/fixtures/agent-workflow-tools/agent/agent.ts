import { e2eAgentConfig } from "@eve-e2e/config";
import { latestTaskResult, outputOf, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { RESEARCH_INTERIM_MESSAGE } from "../task-scenario-text.ts";
import { respondToTaskScenario } from "./lib/task-scenarios.ts";

/**
 * The child-opening call each SUBAGENT-HOOKS mode makes: an agent call the
 * model waits on, a task whose run opens a helper while the model keeps
 * answering, or a waiting workflow tool.
 */
const HOOK_SCENARIO_CALLS = {
  direct: { name: "workflow-marker", input: { message: "Alice's hook audit" } },
  background: { name: "research_brief", input: { topic: "Alice's hook audit" } },
  waiting: { name: "blocking_agent", input: { service: "hook-audit" } },
} as const;

/**
 * public-catalog lists its tools without sign-in: connect it, which needs no
 * sign-in, run its public tool, then its protected one, which asks the user to
 * sign in and resumes once they have.
 */
function respondToPublicCatalog(request: MockModelRequest): MockModelResponse | string {
  const call = (id: string, tool: string) => ({
    id,
    name: "eve__execute",
    input: { tool: `public-catalog__${tool}`, input: {} },
  });
  const byId = new Map(request.toolResults.map((entry) => [entry.id, entry]));
  if (!byId.has("public-catalog-connect")) {
    return {
      toolCalls: [
        { id: "public-catalog-connect", name: "execute", input: { tool: "public-catalog" } },
      ],
    };
  }
  if (!byId.has("public-catalog-items")) {
    return { toolCalls: [call("public-catalog-items", "list_items")] };
  }
  const orders = byId.get("public-catalog-orders");
  if (orders === undefined) {
    return { toolCalls: [call("public-catalog-orders", "list_orders")] };
  }
  return `PUBLIC_CATALOG_DONE ${JSON.stringify(orders.output)}`;
}

/**
 * Deterministic script: each directive names the workflow tool to call with
 * service "api"; once the turn holds a tool result the reply echoes it.
 */
async function respond(request: MockModelRequest): Promise<MockModelResponse | string> {
  const hookScenario = request.userMessages.find((entry) => entry.includes("SUBAGENT-HOOKS:"));
  if (hookScenario !== undefined) {
    const auditing = request.lastUserMessage?.includes("SUBAGENT-HOOKS:AUDIT");
    const skillCallId = auditing ? "audit-policy" : "initial-policy";
    if (!request.toolResults.some((entry) => entry.id === skillCallId)) {
      return {
        toolCalls: [
          { id: skillCallId, name: "eve__execute", input: { skill: "delegation-policy" } },
        ],
      };
    }
    const mode = (/SUBAGENT-HOOKS:(direct|background|waiting)/u.exec(hookScenario)?.[1] ??
      "waiting") as keyof typeof HOOK_SCENARIO_CALLS;
    if (auditing) {
      const auditTool = request.lastUserMessage?.includes("DYNAMIC-SKILL-CONTEXT")
        ? "read_dynamic_skill_context"
        : "read_subagent_hooks";
      const audit = request.toolResults.find((entry) => entry.name === auditTool);
      return audit === undefined
        ? { toolCalls: [{ name: auditTool, input: {} }] }
        : JSON.stringify(audit.output);
    }
    const { name: tool, input } = HOOK_SCENARIO_CALLS[mode];
    const call = request.toolResults.find((entry) => entry.name === tool);
    if (call === undefined) return { toolCalls: [{ name: tool, input }] };
    // An agent call or task returned a receipt; its result arrives in a <task_result> message.
    if (mode === "direct") {
      return (
        latestTaskResult(request, tool) ?? { toolCalls: [{ name: "eve__task_wait", input: {} }] }
      );
    }
    // Ends the step with text while the task works, which holds the turn. The
    // step takes a few seconds, so the task's helper most likely opens while it
    // runs; that is likely, not guaranteed, and the hook assertions hold
    // whether the helper opens mid-step or while the turn is held.
    if (mode === "background") {
      const result = latestTaskResult(request, tool);
      if (result !== undefined) return result;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return RESEARCH_INTERIM_MESSAGE;
    }
    return typeof call.output === "string" ? call.output : JSON.stringify(call.output);
  }

  if (request.userMessages.some((entry) => entry.startsWith("PUBLIC-CATALOG-E2E"))) {
    return respondToPublicCatalog(request);
  }
  const message =
    [...request.userMessages].reverse().find((entry) => entry.startsWith("WORKFLOW-")) ?? "";
  const scenario = respondToTaskScenario(request, directiveOf(message));
  if (scenario !== undefined) return scenario;
  if (message.startsWith("WORKFLOW-CATALOG-SIGN-IN")) {
    // A plain search finds the catalog as its sign-in entry; executing it asks
    // the user. Sign-in drops that interrupted call from history, so the script
    // makes it again once the turn resumes, then searches and calls a tool.
    return playScript(
      request,
      [
        { id: "catalog-search", name: "search", input: () => ({ query: "private-catalog" }) },
        { id: "catalog-sign-in", name: "execute", input: () => ({ tool: "private-catalog" }) },
        { id: "catalog-tools", name: "search", input: () => ({ query: "private-catalog" }) },
        {
          id: "catalog-items",
          name: "execute",
          input: () => ({ tool: "private-catalog__list_items" }),
        },
      ],
      (finished) => outputOf(finished, "catalog-items"),
    );
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
  for (const [directive, tool, service = "api"] of [
    ["WORKFLOW-APPROVAL-START", "gated_deploy"],
    ["WORKFLOW-APPROVAL-DENIED-START", "gated_deploy", "review-only"],
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
      return { toolCalls: [{ input: { service }, name: tool }] };
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

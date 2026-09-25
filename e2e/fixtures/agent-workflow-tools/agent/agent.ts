import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponder,
  type MockModelResponse,
} from "eve/evals";

import { respondTasks } from "./lib/tasks-script.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * Detached task flows, one `BG-*-START` directive per session. A held turn
 * echoes the `<task_result>` message it receives, and each flow starts its
 * tools once.
 */
function respondBackground(request: MockModelRequest): MockModelResponse | string | undefined {
  const last = request.lastUserMessage ?? "";
  const directive = request.userMessages
    .map((entry) => /BG-[A-Z]+-START/u.exec(entry)?.[0])
    .find((entry) => entry !== undefined);
  // A check can follow a compaction that summarized the directive away.
  const noteCheck = last.includes("BG-NOTE-CHECK");
  if (directive === undefined && !noteCheck) return undefined;
  // Compaction summarizes without tools.
  if (request.tools.length === 0) return "BG-SUMMARY";
  if (last.startsWith("<task_result")) return `BG-RESULT ${last}`;
  if (noteCheck) {
    const note = request.messages
      .filter((message) => message.role === "user" && message.text.startsWith("[Tasks]"))
      .at(-1);
    return `BG-NOTE ${note?.text ?? "none"}`;
  }
  const results = (name: string) => request.toolResults.filter((entry) => entry.name === name);

  switch (directive) {
    case "BG-SLEEP-START": {
      const slept = results("sleep")[0];
      if (slept !== undefined) return `BG-SLEPT ${text(slept.output)}`;
      return { toolCalls: [{ input: { seconds: 600 }, name: "sleep" }] };
    }
    case "BG-CANCEL-START":
    case "BG-NOTE-START": {
      if (last.includes("BG-IDLE")) return "BG-IDLE-REPLY";
      const receipt = text(results("remind_later")[0]?.output);
      if (last.includes("BG-STOP")) {
        const stopped = results("task_cancel")[0];
        if (stopped !== undefined) return `BG-CANCELLED ${text(stopped.output)}`;
        const taskId = /remind_later-[0-9a-z]{6}/u.exec(receipt)?.[0] ?? "unknown";
        return { toolCalls: [{ input: { taskId }, name: "task_cancel" }] };
      }
      if (results("remind_later").length > 0) return "BG-STARTED";
      const seconds = { "BG-CANCEL-START": 20, "BG-NOTE-START": 120 }[directive];
      return {
        toolCalls: [{ input: { note: "water the office plants", seconds }, name: "remind_later" }],
      };
    }
    default:
      return "BG-IDLE-REPLY";
  }
}

/**
 * Deterministic script: each directive names the workflow tool to call with
 * service "api"; once the turn holds a tool result the reply echoes it. An
 * agent the script calls directly returns a receipt, so the script waits for
 * its result.
 */
const respondWorkflow = waitForTasks((request) => {
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
    const result = request.toolResults.find((entry) => entry.name === tool);
    return typeof result?.output === "string" ? result.output : JSON.stringify(result?.output);
  }

  const message =
    [...request.userMessages]
      .reverse()
      .find((entry) => entry.startsWith("WORKFLOW-") || entry.includes("private-catalog")) ?? "";
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
  if (message.includes("WORKFLOW-MIXED-AGENTS-START")) {
    const mixedResults = request.toolResults.filter(
      (result) => result.name === "blocking_agent" || result.name === "workflow-marker",
    );
    if (mixedResults.length < 2) {
      return {
        toolCalls: [
          { id: "blocking-agent-call", input: { service: "api" }, name: "blocking_agent" },
          { id: "direct-agent-call", input: { message: "api:direct" }, name: "workflow-marker" },
        ],
      };
    }
    return `WORKFLOW-MIXED-AGENTS-RESULT ${mixedResults
      .map((result) =>
        typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      )
      .join(" ")}`;
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
});

const respond: MockModelResponder = (request) =>
  respondTasks(request) ?? respondBackground(request) ?? respondWorkflow(request);

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});

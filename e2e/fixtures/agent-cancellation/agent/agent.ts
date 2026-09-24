import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const RECOVERY_REQUEST = "RESUME-CANCELLED-SLEEPER";
const HITL_REQUEST = "GENERATED-PROGRAM-CHILD-HITL";

async function respond(request: MockModelRequest): Promise<MockModelResponse | string> {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Alice is preparing the 2026 report.")) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return "Original 2026 report";
  }
  if (message.includes("Alice corrected the report year to 2025.")) {
    return "Corrected 2025 report";
  }
  if (message.includes("Please complete work before answering.")) {
    return request.toolResults.some((result) => result.id === "complete-work")
      ? "The work item is complete."
      : { toolCalls: [{ id: "complete-work", input: {}, name: "complete-work" }] };
  }
  if (message.includes("Please wait for cancellation.")) {
    return {
      toolCalls: [{ id: "wait-for-cancellation", input: {}, name: "wait-for-cancellation" }],
    };
  }
  const markers = [...message.matchAll(/record-request with marker "([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  if (markers.length > 0) {
    const pending = markers.filter(
      (marker) => !request.toolResults.some((entry) => entry.id === `record-${marker}`),
    );
    return pending.length > 0
      ? {
          toolCalls: pending.map((marker) => ({
            id: `record-${marker}`,
            input: { marker },
            name: "record-request",
          })),
        }
      : markers
          .map((marker) =>
            String(request.toolResults.find((entry) => entry.id === `record-${marker}`)?.output),
          )
          .join("\n");
  }
  if (message.includes("call the sleeper subagent")) {
    const hitl = message.includes(HITL_REQUEST);
    const hitlResult = request.toolResults.find((entry) => entry.id === "hitl-sleeper");
    if (hitlResult !== undefined) {
      return typeof hitlResult.output === "string"
        ? hitlResult.output
        : JSON.stringify(hitlResult.output);
    }
    return {
      toolCalls: [
        {
          id: hitl ? "hitl-sleeper" : "cancel-sleeper",
          input: {
            js: hitl
              ? `return await ctx.agent("sleeper", { message: ${JSON.stringify(HITL_REQUEST)} });`
              : 'return await ctx.agent("sleeper", { message: "Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled." });',
          },
          name: "workflow",
        },
      ],
    };
  }
  if (message.includes("[Tasks] note")) {
    return (
      [...request.messages].reverse().find((entry) => entry.text.startsWith("[Tasks]"))?.text ??
      "No agents listed."
    );
  }
  if (message.includes(RECOVERY_REQUEST)) {
    const result = request.toolResults.find((entry) => entry.id === "resume-sleeper");
    if (result !== undefined) {
      return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    }
    const agentId = /agentId ("[^"]+")/u.exec(message)?.[1];
    if (agentId === undefined) throw new Error("Recovery prompt has no sleeper agent id.");
    return {
      toolCalls: [
        {
          id: "resume-sleeper",
          input: {
            js: `return await ctx.agent("sleeper", { agentId: ${agentId}, message: ${JSON.stringify(RECOVERY_REQUEST)} });`,
          },
          name: "workflow",
        },
      ],
    };
  }
  return `Mock reply: ${message}`;
}

// The workflow tool starts detached tasks; the script reads their results.
const base = e2eAgentConfig({ mock: waitForTasks(respond) });

export default defineAgent({
  ...base,
});

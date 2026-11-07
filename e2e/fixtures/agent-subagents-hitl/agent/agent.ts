import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import {
  CHILD_MARKER,
  CHILD_REPORT,
  FAN_IN_DONE,
  FAN_IN_MARKER,
  describeCall,
  planAfter,
  type ChildPlan,
  type FanInPlan,
} from "./lib/weather-sign-in";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const fanIn = planAfter<FanInPlan>(message, FAN_IN_MARKER);
  if (fanIn !== undefined) return signInFanIn(request, fanIn);
  if (message.includes("Read the parent input-hook audit")) {
    const audit = request.toolResults.find((result) => result.name === "read_input_hooks");
    return audit === undefined
      ? { toolCalls: [{ name: "read_input_hooks", input: {} }] }
      : JSON.stringify(audit.output);
  }
  if (message.includes("Call the approval-child subagent exactly once")) {
    const approval = taskResultOf(request, "approval-child");
    if (approval !== undefined) return approval;
    if (hasReceipt(request, "approval-child")) return waitForTasks();
    return {
      toolCalls: [
        {
          input: { message: "Ask whether to deploy, then wait for the answer." },
          name: "approval-child",
        },
      ],
    };
  }
  if (message.includes("Call the release-pair subagent exactly once")) {
    const result = taskResultOf(request, "release-pair");
    if (result !== undefined) return `The release-pair subagent returned: ${result}`;
    if (hasReceipt(request, "release-pair")) return waitForTasks();
    return {
      toolCalls: [
        { input: { message: "Deploy the release and publish its notes." }, name: "release-pair" },
      ],
    };
  }
  // RELAY-<child>: delegate to that mock child once, wait for it, and report its result.
  const relay = /RELAY-(question-child|budget-child)/u.exec(message)?.[1];
  if (relay !== undefined) {
    const result = taskResultOf(request, relay);
    if (result !== undefined) return `RELAY-RESULT ${result}`;
    if (hasReceipt(request, relay)) return waitForTasks();
    return { toolCalls: [{ input: { message: "Handle Alice's release request." }, name: relay }] };
  }
  if (message.includes("Call the stock-price subagent exactly once")) {
    const quote = taskResultOf(request, "stock-price");
    if (quote !== undefined) return `The stock-price subagent returned: ${quote}`;
    if (hasReceipt(request, "stock-price")) return waitForTasks();
    return {
      toolCalls: [
        {
          input: {
            message:
              'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.',
          },
          name: "stock-price",
        },
      ],
    };
  }
  if (request.lastUserMessage?.includes(COLLISION_MARKER) !== true) {
    return `Mock reply: ${message}`;
  }

  const gateResults = request.toolResults.filter((result) => result.name === "collision-gate");
  const subagentResults = request.toolResults.filter((result) => result.name === "collision-child");

  if (gateResults.length === 0 && subagentResults.length === 0) {
    return {
      toolCalls: [
        {
          id: "collision-gate-call",
          input: { marker: COLLISION_MARKER },
          name: "collision-gate",
        },
        {
          id: "collision-child-call",
          input: { message: `Return ${COLLISION_MARKER}.` },
          name: "collision-child",
        },
      ],
    };
  }

  if (gateResults.length === 1 && subagentResults.length === 1) {
    return COLLISION_MARKER;
  }

  throw new Error("Mixed runtime-action step resumed before both tool results were available.");
}

/**
 * The parent runs `children` weather children in one step and waits for every report. With
 * `late`, the last child starts only after the others report. With `parent`, the parent checks
 * Lisbon itself in the next step, while the children's calls are out, and reports that call's
 * result with the children's.
 */
function signInFanIn(request: MockModelRequest, plan: FanInPlan): MockModelResponse | string {
  const reports = taskResultsOf(request, "weather-child");
  const started = request.toolResults.filter((result) => result.name === "weather-child").length;
  const first = plan.late === true ? plan.children - 1 : plan.children;
  if (started === 0)
    return {
      toolCalls: Array.from({ length: first }, (_, index) => weatherChild(plan, index)),
    };
  if (plan.parent === true && !hasReceipt(request, "get_weather"))
    return { toolCalls: [parentWeather] };
  if (started < plan.children && reports.length === started)
    return { toolCalls: [weatherChild(plan, started)] };
  if (reports.length < plan.children) return waitForTasks();
  const own = request.toolResults
    .filter((result) => result.name === "get_weather")
    .map((call) => `${CHILD_REPORT} ${describeCall(call.output, call.isError)}`);
  return [FAN_IN_DONE, ...own, ...reports].join("\n");
}

const parentWeather = {
  id: "parent-weather",
  input: { city: "Lisbon parent", parent: true },
  name: "get_weather",
};

function weatherChild(plan: FanInPlan, index: number) {
  const child: ChildPlan = {
    city: `Lisbon ${index}`,
    ...(plan.hold === true && {
      holdFor: Array.from({ length: plan.children }, (_, other) => `Lisbon ${other}`).filter(
        (city) => city !== `Lisbon ${index}`,
      ),
    }),
    ...(plan.again === true && index === 0 && { again: true }),
    ...(plan.retry === true && index === 0 && { retry: true }),
    ...(plan.otherFrom !== undefined && index >= plan.otherFrom && { other: true }),
    ...(plan.parentFirst === true && { afterParent: true }),
  };
  return {
    id: `weather-child-${index}`,
    input: { message: `${CHILD_MARKER} ${JSON.stringify(child)}` },
    name: "weather-child",
  };
}

/** Every `<task_result>` the agent `tool` returned so far, oldest first. */
function taskResultsOf(request: MockModelRequest, tool: string): string[] {
  const pattern = new RegExp(
    `<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`,
    "gu",
  );
  return request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => [...message.text.matchAll(pattern)].map((match) => match[1]!));
}

/** An agent call returns a receipt; its result arrives later in a `<task_result>` message. */
function taskResultOf(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(`<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`);
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const body = message.text.match(pattern)?.[1];
    if (body !== undefined) return body;
  }
  return undefined;
}

function hasReceipt(request: MockModelRequest, tool: string): boolean {
  return request.toolResults.some((result) => result.name === tool);
}

function waitForTasks(): MockModelResponse {
  return { toolCalls: [{ input: {}, name: "eve__task_wait" }] };
}

const agent: DefinedAgent = defineAgent({
  ...e2eAgentConfig(),
  // Parking coverage requires both actions in one step; children still use the matrix model.
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});

export default agent;

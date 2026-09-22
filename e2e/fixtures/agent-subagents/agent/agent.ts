import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";
import { NESTED_BACKGROUND, nestedBackgroundModel } from "./lib/nested-background-model.js";

import {
  SCHEDULED_REMOTE_CHILD_SCENARIO,
  SCHEDULED_REMOTE_ROOT_SCENARIO,
  WORKSPACE_FORWARDING_MARKER,
  WORKSPACE_LOOKUP_MESSAGE,
} from "../constants";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const TOOL_FALSE_PROBE = "E2E_TOOL_FALSE_SUBAGENT";
const DISABLED_TOOL_PROBE = "E2E_DISABLED_SUBAGENT";
const hiddenSubagentProbe = mockModel({
  modelId: "hidden-subagent-probe",
  respond(request) {
    const probe = [...request.userMessages]
      .reverse()
      .find(
        (message) => message.includes(TOOL_FALSE_PROBE) || message.includes(DISABLED_TOOL_PROBE),
      );
    const target = probe?.includes(TOOL_FALSE_PROBE) ? "tool-hidden" : "disabled-hidden";
    if (request.tools.some((tool) => tool.name === target)) {
      throw new Error(`Internal subagent ${target} was exposed to the model.`);
    }
    if (!request.tools.some((tool) => tool.name === "invoke-hidden")) {
      throw new Error("The visible invoke-hidden workflow tool is missing.");
    }
    const result = request.toolResults.find((entry) => entry.name === "invoke-hidden");
    return result === undefined
      ? { toolCalls: [{ name: "invoke-hidden", input: { target } }] }
      : JSON.stringify(result.output);
  },
});

const base = e2eAgentConfig();
const { model, modelContextWindowTokens, ...agentConfig } = base;
const defaultModel = typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
const workspaceReader = mockModel({
  modelId: "principal-forwarding-workspace-reader",
  respond: ({ messages }) => {
    for (const message of [...messages].reverse()) {
      if (message.role === "tool") return message.text;
      if (message.role === "user" && message.text === WORKSPACE_LOOKUP_MESSAGE) break;
    }
    return { toolCalls: [{ name: "read-workspace-label", input: {} }] };
  },
});
const workspaceDispatcher = mockModel({
  modelId: "principal-forwarding-workspace-dispatcher",
  respond(request) {
    let requestIndex = -1;
    for (const [index, message] of request.messages.entries()) {
      if (message.role === "user" && message.text.includes(WORKSPACE_FORWARDING_MARKER)) {
        requestIndex = index;
      }
    }
    if (
      requestIndex < 0 ||
      request.messages.slice(requestIndex + 1).some((message) => message.role === "tool")
    ) {
      return "The workspace lookup was submitted.";
    }
    const previous = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "remote-loopback")?.output;
    const agentId =
      previous !== null &&
      typeof previous === "object" &&
      "agentId" in previous &&
      typeof previous.agentId === "string"
        ? previous.agentId
        : undefined;
    const requestCount = request.messages.filter(
      (message) => message.role === "user" && message.text.includes(WORKSPACE_FORWARDING_MARKER),
    ).length;
    if (requestCount > 1 && agentId === undefined) {
      throw new Error("Workspace continuation has no existing remote agent receipt.");
    }
    return {
      toolCalls: [
        {
          id: `workspace-lookup-${requestCount}`,
          name: "remote-loopback",
          input: { agentId, message: WORKSPACE_LOOKUP_MESSAGE },
        },
      ],
    };
  },
});
const scheduledRemoteModel = mockModel({
  modelId: "scheduled-remote-completion",
  respond(request) {
    if (request.userMessages.some((message) => message.includes(SCHEDULED_REMOTE_CHILD_SCENARIO))) {
      return "SCHEDULED-REMOTE-CHILD-RESULT";
    }

    const remote = completedTaskOutput(request.userMessages, "remote-loopback");
    if (remote !== undefined) return `SCHEDULED-REMOTE-FINAL ${remote}`;
    if (!request.toolResults.some((result) => result.id === "scheduled-remote")) {
      return {
        toolCalls: [
          {
            id: "scheduled-remote",
            input: { message: SCHEDULED_REMOTE_CHILD_SCENARIO },
            name: "remote-loopback",
          },
        ],
      };
    }
    return "Weekly report could not be completed before delivery because the analytics query did not return a result.";
  },
});

function completedTaskOutput(messages: readonly string[], name: string): string | undefined {
  const prefix = "[Task state]\n";
  const state = [...messages].reverse().find((message) => message.startsWith(prefix));
  if (state === undefined) return undefined;
  const parsed: unknown = JSON.parse(state.slice(prefix.length));
  if (parsed === null || typeof parsed !== "object") return undefined;
  const tasks = Reflect.get(parsed, "tasks");
  if (!Array.isArray(tasks)) return undefined;
  const task = tasks.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "name") === name &&
      Reflect.get(candidate, "status") === "completed",
  );
  if (task === undefined) return undefined;
  const output = Reflect.get(task, "output");
  return output !== null &&
    typeof output === "object" &&
    Reflect.get(output, "type") === "result" &&
    typeof Reflect.get(output, "data") === "string"
    ? (Reflect.get(output, "data") as string)
    : undefined;
}

export default defineAgent({
  ...agentConfig,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const messages = ctx.messages.flatMap((message) => {
          if (message.role !== "user") return [];
          return [
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          ];
        });
        if (messages.some((message) => message.startsWith(NESTED_BACKGROUND))) {
          return { model: nestedBackgroundModel, modelContextWindowTokens: 1_000_000 };
        }
        if (
          messages.some(
            (message) =>
              message.includes(TOOL_FALSE_PROBE) || message.includes(DISABLED_TOOL_PROBE),
          )
        ) {
          return { model: hiddenSubagentProbe, modelContextWindowTokens: 1_000_000 };
        }
        // Both models must reach the real authorization boundary, including denied lookups.
        if (messages.includes(WORKSPACE_LOOKUP_MESSAGE)) {
          return { model: workspaceReader, modelContextWindowTokens: 1_000_000 };
        }
        if (messages.some((message) => message.includes(WORKSPACE_FORWARDING_MARKER))) {
          return { model: workspaceDispatcher, modelContextWindowTokens: 1_000_000 };
        }
        if (
          messages.some(
            (message) =>
              message.includes(SCHEDULED_REMOTE_ROOT_SCENARIO) ||
              message.includes(SCHEDULED_REMOTE_CHILD_SCENARIO),
          )
        ) {
          return { model: scheduledRemoteModel, modelContextWindowTokens: 1_000_000 };
        }
        return { model: defaultModel, modelContextWindowTokens };
      },
    },
  }),
  reasoning: "high",
});

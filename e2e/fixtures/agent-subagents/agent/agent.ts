import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import { WORKSPACE_FORWARDING_MARKER, WORKSPACE_LOOKUP_MESSAGE } from "../constants";

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
    const agentId = findAnnouncedAgentId(request.messages, "remote-loopback");
    const requestCount = request.messages.filter(
      (message) => message.role === "user" && message.text.includes(WORKSPACE_FORWARDING_MARKER),
    ).length;
    if (requestCount > 1 && agentId === undefined) {
      throw new Error("Workspace continuation has no remote agent in the <agents> note.");
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
/** Reads the id the framework-injected `[Agents]` note lists for a parked child. */
function findAnnouncedAgentId(
  messages: readonly { readonly role: string; readonly text: string }[],
  name: string,
): string | undefined {
  const announcement = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.text.startsWith("[Agents]"));
  const pattern = new RegExp(`<agent id="([^"]+)" name="${name}">`);
  return announcement?.text.match(pattern)?.[1];
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
        return { model: defaultModel, modelContextWindowTokens };
      },
    },
  }),
  reasoning: "high",
});

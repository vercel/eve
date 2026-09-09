import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import { WORKSPACE_FORWARDING_MARKER, WORKSPACE_LOOKUP_MESSAGE } from "../constants";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const base = e2eAgentConfig();
const { model, modelContextWindowTokens, ...agentConfig } = base;
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
        // Both models must reach the real authorization boundary, including denied lookups.
        if (messages.includes(WORKSPACE_LOOKUP_MESSAGE)) {
          return { model: workspaceReader, modelContextWindowTokens: 1_000_000 };
        }
        if (messages.some((message) => message.includes(WORKSPACE_FORWARDING_MARKER))) {
          return { model: workspaceDispatcher, modelContextWindowTokens: 1_000_000 };
        }
        return { model, modelContextWindowTokens };
      },
    },
  }),
  reasoning: "high",
});

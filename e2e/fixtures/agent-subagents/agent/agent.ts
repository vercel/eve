import { e2eAgentConfig } from "@eve-e2e/config";
import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import {
  TENANT_REMOTE_DIRECTIVE,
  TENANT_WHOAMI_MESSAGE,
  MODEL_AGENT_SELECTED_MODEL,
  WORKSPACE_FORWARDING_MARKER,
  WORKSPACE_LOOKUP_MESSAGE,
} from "../constants";
import {
  REMOTE_QUESTION_DIRECTIVE,
  respondToRemoteQuestion,
} from "./lib/remote-question-script.js";
import { isNestedDirective, respondToNestedRequest } from "./lib/remote-nested-script.js";
import { isDirectHitlDirective, respondToDirectHitl } from "./lib/remote-direct-hitl-script.js";
import {
  isNotebookDirective,
  isNotebookEntry,
  respondAsNotebookKeeper,
  respondAsNotebookParent,
} from "./lib/notebook.js";
import {
  isSurveyDirective,
  isSurveyToolDirective,
  respondAsSurveyParent,
  respondAsSurveyToolParent,
} from "./lib/survey.js";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const DYNAMIC_SUBAGENT_PROBE = "E2E_DYNAMIC_SUBAGENT_CATALOG";
const dynamicSubagentProbe = mockModel({
  modelId: "dynamic-subagent-catalog",
  respond(request) {
    if (!request.tools.some((tool) => tool.name === "conditional-marker")) {
      throw new Error("The resolved dynamic subagent is missing from the model's tools.");
    }
    if (request.tools.some((tool) => tool.name === "omitted-marker")) {
      throw new Error("A dynamic subagent that resolved to null was exposed to the model.");
    }
    return playScript(
      request,
      [
        {
          id: "dynamic-start",
          name: "conditional-marker",
          input: () => ({ message: "Return your marker." }),
        },
        { id: "dynamic-wait", name: "eve__task_wait" },
      ],
      (finished) => latestTaskResult(finished, "conditional-marker") ?? "No dynamic child result.",
    );
  },
});

const TOOL_FALSE_PROBE = "E2E_TOOL_FALSE_SUBAGENT";
const MODEL_AGENT_PROBE = "E2E_MODEL_SELECTING_AGENT_TOOL";
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
const modelSelectingParent = mockModel({
  modelId: "model-selecting-agent-parent",
  respond(request) {
    if (hasInputProperty(request.tools, "agent", "model")) {
      throw new Error("The default agent tool exposed a model input.");
    }
    if (!hasInputProperty(request.tools, "model_agent", "model")) {
      throw new Error("The custom model_agent tool did not expose its model input.");
    }
    const defaultResult = latestTaskResult(request, "agent");
    const selectedResult = latestTaskResult(request, "model_agent");
    if (defaultResult !== undefined && selectedResult !== undefined) {
      return `${defaultResult}\n${selectedResult}`;
    }
    if (request.toolResults.some((result) => ["agent", "model_agent"].includes(result.name))) {
      return { toolCalls: [{ name: "eve__task_wait", input: {} }] };
    }
    return {
      toolCalls: [
        {
          id: "default-agent-call",
          name: "agent",
          input: { message: "Reply with exactly DEFAULT_AGENT_MODEL_OK" },
        },
        {
          id: "model-agent-call",
          name: "model_agent",
          input: {
            message: "Reply with exactly SELECTED_AGENT_MODEL_OK",
            model: MODEL_AGENT_SELECTED_MODEL,
          },
        },
      ],
    };
  },
});
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
    const requests = request.messages.filter(
      (message) => message.role === "user" && message.text.includes(WORKSPACE_FORWARDING_MARKER),
    );
    const requestCount = requests.length;
    // Only a continuation names the task, which the [Tasks] note lists.
    const continuing = requests.at(-1)?.text.includes("taskId") === true;
    const taskId = continuing ? findListedTaskId(request.messages, "remote-loopback") : undefined;
    if (continuing && taskId === undefined) {
      throw new Error("Workspace continuation has no remote-loopback task in the [Tasks] note.");
    }
    return {
      toolCalls: [
        {
          id: `workspace-lookup-${requestCount}`,
          name: "remote-loopback",
          input: { message: WORKSPACE_LOOKUP_MESSAGE, taskId },
        },
      ],
    };
  },
});
// The tenant-remote child reports who it runs as; the parent opens it, then continues it.
const tenantChild = mockModel({
  modelId: "tenant-remote-child",
  respond: ({ messages }) => {
    for (const message of [...messages].reverse()) {
      if (message.role === "tool") return message.text;
      if (message.role === "user" && message.text === TENANT_WHOAMI_MESSAGE) break;
    }
    return { toolCalls: [{ name: "whoami", input: {} }] };
  },
});
const tenantDispatcher = mockModel({
  modelId: "tenant-remote-dispatcher",
  respond(request) {
    const requests = request.messages.filter(
      (message) => message.role === "user" && message.text.includes(TENANT_REMOTE_DIRECTIVE),
    );
    const latest = request.messages.lastIndexOf(requests.at(-1)!);
    if (request.messages.slice(latest + 1).some((message) => message.role === "tool")) {
      return "The tenant-remote request was submitted.";
    }
    const continuing = requests.at(-1)?.text.includes("taskId") === true;
    const taskId = continuing ? findListedTaskId(request.messages, "tenant-remote") : undefined;
    if (continuing && taskId === undefined) {
      throw new Error("Tenant continuation has no tenant-remote task in the [Tasks] note.");
    }
    return {
      toolCalls: [
        {
          id: `tenant-remote-${requests.length}`,
          name: "tenant-remote",
          input: { message: TENANT_WHOAMI_MESSAGE, taskId },
        },
      ],
    };
  },
});
const remoteQuestionModel = mockModel({
  modelId: "remote-question",
  respond: respondToRemoteQuestion,
});
const remoteNestedModel = mockModel({ modelId: "remote-nested", respond: respondToNestedRequest });
const remoteDirectHitlModel = mockModel({
  modelId: "remote-direct-hitl",
  respond: respondToDirectHitl,
});
const notebookParent = mockModel({ modelId: "notebook-parent", respond: respondAsNotebookParent });
const surveyParent = mockModel({ modelId: "survey-parent", respond: respondAsSurveyParent });
const surveyToolParent = mockModel({
  modelId: "survey-tool-parent",
  respond: respondAsSurveyToolParent,
});
// The remote keeper is a root session of this deployment, reached through remote-loopback.
const notebookKeeper = mockModel({ modelId: "notebook-keeper", respond: respondAsNotebookKeeper });
function hasInputProperty(
  tools: readonly { readonly inputSchema?: unknown; readonly name: string }[],
  toolName: string,
  property: string,
): boolean {
  const schema = tools.find((tool) => tool.name === toolName)?.inputSchema;
  if (typeof schema !== "object" || schema === null) return false;
  const properties = Reflect.get(schema, "properties");
  return typeof properties === "object" && properties !== null && property in properties;
}

/** Reads the id of a tool's task from the latest framework-injected `[Tasks]` note. */
function findListedTaskId(
  messages: readonly { readonly role: string; readonly text: string }[],
  tool: string,
): string | undefined {
  const note = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.text.startsWith("[Tasks]"));
  const pattern = new RegExp(`<task id="([^"]+)" tool="${tool}"`);
  return note?.text.match(pattern)?.[1];
}

export default defineAgent({
  ...agentConfig,
  model: defineDynamic(async (ctx) => {
    const messages = (await ctx.messages()).flatMap((message) => {
      if (message.role !== "user") return [];
      return [
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ];
    });
    const scripted = (scriptedModel: ReturnType<typeof mockModel>) => ({
      model: scriptedModel,
      modelContextWindowTokens: 1_000_000,
    });
    if (messages.some((message) => message.includes(DYNAMIC_SUBAGENT_PROBE))) {
      return scripted(dynamicSubagentProbe);
    }
    if (messages.some((message) => message.includes(MODEL_AGENT_PROBE))) {
      return scripted(modelSelectingParent);
    }
    if (
      messages.some(
        (message) => message.includes(TOOL_FALSE_PROBE) || message.includes(DISABLED_TOOL_PROBE),
      )
    ) {
      return scripted(hiddenSubagentProbe);
    }
    // Both models must reach the real authorization boundary, including denied lookups.
    if (messages.includes(WORKSPACE_LOOKUP_MESSAGE)) return scripted(workspaceReader);
    if (messages.some((message) => message.includes(WORKSPACE_FORWARDING_MARKER))) {
      return scripted(workspaceDispatcher);
    }
    if (messages.includes(TENANT_WHOAMI_MESSAGE)) return scripted(tenantChild);
    if (messages.some((message) => message.includes(TENANT_REMOTE_DIRECTIVE))) {
      return scripted(tenantDispatcher);
    }
    if (messages.some((message) => message.includes(REMOTE_QUESTION_DIRECTIVE))) {
      return scripted(remoteQuestionModel);
    }
    if (messages.some(isNestedDirective)) return scripted(remoteNestedModel);
    if (messages.some(isDirectHitlDirective)) return scripted(remoteDirectHitlModel);
    if (messages.some(isNotebookEntry)) return scripted(notebookKeeper);
    if (messages.some(isNotebookDirective)) return scripted(notebookParent);
    if (messages.some(isSurveyDirective)) return scripted(surveyParent);
    if (messages.some(isSurveyToolDirective)) return scripted(surveyToolParent);
    return { model: defaultModel, modelContextWindowTokens };
  }),
  reasoning: "high",
});

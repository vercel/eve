import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineDynamic } from "#dynamic/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";
import { always } from "#tools/approval/policies.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import {
  failingDeployWorkflow,
  failingServeWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { STUB_CONTEXT_KEY, type ToolStub } from "#tool-stubs/types.js";

vi.setConfig({ testTimeout: 90_000 });

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

type Prompt = LanguageModelV4CallOptions["prompt"];
interface Call {
  readonly toolName: string;
  readonly input?: unknown;
}

/** A model that answers each request with `script`'s calls or text, counting its requests. */
function scriptedModel(script: (request: number, prompt: Prompt) => readonly Call[] | string) {
  const requests: Prompt[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      requests.push(prompt);
      const next = script(requests.length, prompt);
      if (typeof next === "string") return textStreamResult(next);
      return toolCallsStreamResult(
        next.map((call, index) => ({
          input: JSON.stringify(call.input ?? {}),
          toolCallId: `call_${requests.length}_${index}`,
          toolName: call.toolName,
        })),
      );
    },
    modelId: "scripted",
    provider: "eve-test",
  });
  return { model: markMockModel(model), requests };
}

/** Runs one turn of a session whose stubs are `rules`, and returns what it streamed. */
async function runStubbedTurn(
  name: string,
  options: {
    readonly message: string;
    readonly model: ReturnType<typeof scriptedModel>["model"];
    readonly rules: readonly ToolStub[];
    readonly tools: readonly (string | WorkflowToolSpec)[];
  },
): Promise<readonly SessionStreamEvent[]> {
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model: options.model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: options.tools.map((tool) => ({
      loadNamespace: async () => ({ default: toolDefinition(tool) }),
      logicalPath: `tools/${typeof tool === "string" ? tool : tool.name}.ts`,
    })),
  });
  return await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: options.message },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http" }),
          "eve.capabilities": { requestInput: true },
          [STUB_CONTEXT_KEY]: { token: `${name}-stubs`, rules: options.rules },
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    try {
      const events = [...(await stream.nextTurn())];
      const asked = events.flatMap((event) =>
        event.type === "interaction.opened" ? [event.data.interactionId] : [],
      );
      if (asked.length === 0) return events;
      await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
        auth: ALICE,
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        kind: "send",
        payload: {
          answers: asked.map((interactionId) => ({ interactionId, optionId: "approve" })),
        },
      });
      return [...events, ...(await stream.nextTurn())];
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
}

const postedEndsTurn = vi.fn((output: { readonly posted: boolean }) => output.posted);

/** A workflow tool whose body must never run, since a stub answers every call to it. */
interface WorkflowToolSpec {
  readonly name: string;
  readonly runs:
    | "execute"
    | "task"
    | "serve"
    | "deferred"
    | "approved"
    | "approved-execute"
    | "ends-turn-if-posted";
}

function toolDefinition(tool: string | WorkflowToolSpec) {
  if (typeof tool === "string") {
    return defineTool({
      description: `Run ${tool}.`,
      execute: async () => ({ real: tool }),
      inputSchema: z.object({}).passthrough(),
    });
  }
  if (tool.runs === "approved") {
    return defineTool({
      approval: { request: always() },
      description: `Run ${tool.name}.`,
      execute: async () => ({ real: tool.name }),
      inputSchema: z.object({}).passthrough(),
    });
  }
  if (tool.runs === "ends-turn-if-posted") {
    return defineTool({
      description: `Run ${tool.name}.`,
      execute: async () => ({ posted: true }),
      inputSchema: z.object({}).passthrough(),
      endsTurn: postedEndsTurn,
    });
  }
  if (tool.runs === "approved-execute") {
    return defineWorkflowTool({
      approval: { request: always() },
      description: `Run ${tool.name}.`,
      execute: failingDeployWorkflow,
      inputSchema: z.object({ service: z.string() }),
    });
  }
  if (tool.runs === "deferred") {
    return defineTool({
      deferred: true,
      description: `Run ${tool.name}.`,
      execute: async () => ({ real: tool.name }),
      inputSchema: z.object({}).passthrough(),
    });
  }
  const description = `Run ${tool.name}.`;
  const inputSchema = z.object({ service: z.string() });
  switch (tool.runs) {
    case "execute":
      return defineWorkflowTool({ description, execute: failingDeployWorkflow, inputSchema });
    case "task":
      return defineWorkflowTool({ description, task: failingDeployWorkflow, inputSchema });
    case "serve":
      return defineWorkflowTool({ description, serve: failingServeWorkflow, inputSchema });
  }
}

function settledCalls(events: readonly SessionStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "call.settled" ? [`${event.data.callId}:${event.data.outcome}`] : [],
  );
}

function turnOutcome(events: readonly SessionStreamEvent[]) {
  return events.flatMap((event) => (event.type === "turn.settled" ? [event.data.outcome] : []));
}

describe("a stub response that ends the turn", () => {
  it("ends the turn after the call, without another model call", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1 ? [{ toolName: "lookup" }] : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn", {
      message: "Look it up.",
      model,
      rules: [{ id: "lookup", tool: "lookup", outcome: { response: "stubbed", endsTurn: true } }],
      tools: ["lookup"],
    });

    expect(requests).toHaveLength(1);
    expect(settledCalls(events)).toEqual(["call_1_0:completed"]);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("lets the model recover from a thrown outcome, and ends on the response after it", async () => {
    const { model, requests } = scriptedModel((request) =>
      request <= 2 ? [{ toolName: "lookup" }] : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn-after-retry", {
      message: "Look it up.",
      model,
      rules: [
        {
          id: "lookup",
          tool: "lookup",
          outcomes: [
            { throw: { message: "Lookup timed out" } },
            { response: "stubbed", endsTurn: true },
          ],
        },
      ],
      tools: ["lookup"],
    });

    expect(requests).toHaveLength(2);
    expect(settledCalls(events)).toEqual(["call_1_0:failed", "call_2_0:completed"]);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("keeps the turn going when another call in the step doesn't end it", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1 ? [{ toolName: "lookup" }, { toolName: "notes" }] : "Here is what I found.",
    );
    const events = await runStubbedTurn("stub-ends-turn-mixed-step", {
      message: "Look it up and check the notes.",
      model,
      rules: [{ id: "lookup", tool: "lookup", outcome: { response: "stubbed", endsTurn: true } }],
      tools: ["lookup", "notes"],
    });

    expect(requests).toHaveLength(2);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("ends the turn after a call that reaches the stubbed tool through eve__tool", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1
        ? [{ toolName: "eve__tool", input: { name: "lookup", input: {} } }]
        : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn-catalog", {
      message: "Look it up.",
      model,
      rules: [{ id: "lookup", tool: "lookup", outcome: { response: "stubbed", endsTurn: true } }],
      tools: [{ name: "lookup", runs: "deferred" }],
    });

    expect(requests).toHaveLength(1);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("ends the turn after an approved call gets its endsTurn response", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1 ? [{ toolName: "publish" }] : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn-approved", {
      message: "Publish it.",
      model,
      rules: [
        { id: "publish", tool: "publish", outcome: { response: "published", endsTurn: true } },
      ],
      tools: [{ name: "publish", runs: "approved" }],
    });

    expect(requests).toHaveLength(1);
    expect(settledCalls(events)).toEqual(["call_1_0:completed"]);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("ends the turn when a call to an endsTurn tool accepts its output beside an ending workflow call", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1
        ? [{ toolName: "post" }, { toolName: "deploy", input: { service: "api" } }]
        : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn-beside-predicate", {
      message: "Post it and deploy it.",
      model,
      rules: [{ id: "deploy", tool: "deploy", outcome: { response: "deployed", endsTurn: true } }],
      tools: [
        { name: "post", runs: "ends-turn-if-posted" },
        { name: "deploy", runs: "execute" },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("ends the turn when approved inline and workflow calls both get endsTurn responses", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1
        ? [{ toolName: "publish" }, { toolName: "deploy", input: { service: "api" } }]
        : "never asked",
    );
    const events = await runStubbedTurn("stub-ends-turn-approved-both", {
      message: "Publish and deploy it.",
      model,
      rules: [
        { id: "publish", tool: "publish", outcome: { response: "published", endsTurn: true } },
        { id: "deploy", tool: "deploy", outcome: { response: "deployed", endsTurn: true } },
      ],
      tools: [
        { name: "publish", runs: "approved" },
        { name: "deploy", runs: "approved-execute" },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("doesn't ask an endsTurn tool beside a failed call when no stub can end the turn", async () => {
    postedEndsTurn.mockClear();
    const { model, requests } = scriptedModel((request) =>
      request === 1 ? [{ toolName: "post" }, { toolName: "notes" }] : "The notes are down.",
    );
    await runStubbedTurn("stub-cannot-end-turn", {
      message: "Post it and check the notes.",
      model,
      rules: [{ id: "notes", tool: "notes", outcome: { throw: { message: "Notes are down" } } }],
      tools: [{ name: "post", runs: "ends-turn-if-posted" }, "notes"],
    });

    expect(requests).toHaveLength(2);
    expect(postedEndsTurn).not.toHaveBeenCalled();
  });

  it("keeps the turn going for a stub response without endsTurn", async () => {
    const { model, requests } = scriptedModel((request) =>
      request === 1 ? [{ toolName: "lookup" }] : "Here is what I found.",
    );
    await runStubbedTurn("stub-continues-turn", {
      message: "Look it up.",
      model,
      rules: [{ id: "lookup", tool: "lookup", outcome: { response: "stubbed" } }],
      tools: ["lookup"],
    });

    expect(requests).toHaveLength(2);
  });
});

describe("a stub response that ends the turn from a workflow tool", () => {
  it.each(["execute", "task", "serve"] as const)(
    "ends the turn once a %s tool's stubbed result is in",
    async (runs) => {
      const { model, requests } = scriptedModel((request) =>
        request === 1 ? [{ toolName: "deploy", input: { service: "api" } }] : "never asked",
      );
      const events = await runStubbedTurn(`stub-ends-turn-${runs}`, {
        message: "Deploy it.",
        model,
        rules: [
          { id: "deploy", tool: "deploy", outcome: { response: "deployed", endsTurn: true } },
        ],
        tools: [{ name: "deploy", runs }],
      });

      expect(turnOutcome(events)).toEqual(["completed"]);
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["execute", "task"] as const)(
    "has the model read an in-step result when a %s call beside it ends the turn",
    async (runs) => {
      const read: Prompt[] = [];
      const { model, requests } = scriptedModel((request, prompt) => {
        if (request === 1)
          return [{ toolName: "notes" }, { toolName: "deploy", input: { service: "api" } }];
        read.push(prompt);
        return "Deployed, and the notes say real.";
      });
      const events = await runStubbedTurn(`stub-ends-turn-beside-notes-${runs}`, {
        message: "Check the notes and deploy it.",
        model,
        rules: [
          { id: "deploy", tool: "deploy", outcome: { response: "deployed", endsTurn: true } },
        ],
        tools: ["notes", { name: "deploy", runs }],
      });

      expect(requests).toHaveLength(runs === "execute" ? 2 : 3);
      expect(JSON.stringify(read)).toContain('"real":"notes"');
      expect(turnOutcome(events)).toEqual(["completed"]);
    },
  );

  it("has the model read a task's result when a task beside it ends the turn", async () => {
    const read: Prompt[] = [];
    const { model, requests } = scriptedModel((request, prompt) => {
      if (request === 1)
        return [
          { toolName: "build", input: { service: "api" } },
          { toolName: "deploy", input: { service: "api" } },
        ];
      read.push(prompt);
      return JSON.stringify(prompt).includes("built-marker") ? "Built." : "Working on it.";
    });
    const events = await runStubbedTurn("stub-ends-turn-beside-task", {
      message: "Build and deploy it.",
      model,
      rules: [
        { id: "build", tool: "build", outcome: { response: "built-marker" } },
        { id: "deploy", tool: "deploy", outcome: { response: "deployed", endsTurn: true } },
      ],
      tools: [
        { name: "build", runs: "task" },
        { name: "deploy", runs: "task" },
      ],
    });

    expect(JSON.stringify(read)).toContain("built-marker");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(turnOutcome(events)).toEqual(["completed"]);
  });

  it("lets the model read a task's start when its stub outcome doesn't end the turn", async () => {
    const read: Prompt[] = [];
    const { model, requests } = scriptedModel((request, prompt) => {
      if (request === 1) return [{ toolName: "deploy", input: { service: "api" } }];
      read.push(prompt);
      return "Deploy started.";
    });
    await runStubbedTurn("stub-task-continues-turn", {
      message: "Deploy it.",
      model,
      rules: [
        {
          id: "deploy",
          tool: "deploy",
          outcomes: [{ response: "first" }, { response: "second", endsTurn: true }],
        },
      ],
      tools: [{ name: "deploy", runs: "serve" }],
    });

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(read[0])).toContain("Started task");
  });
});

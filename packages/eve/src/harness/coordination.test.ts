import { describe, expect, it } from "vitest";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import {
  createCoordinationRequestFromToolCall,
  createRuntimeActionRequestFromToolCall,
  resolvePendingCoordination,
  resolveToolCallInputObject,
  setPendingCoordinationBatch,
} from "#harness/coordination.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  getBlockingWorkflowToolRuns,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";

import { toolOutput } from "#tools/model-output.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { isRuntimeWorkflowToolAction } from "#shared/action-types.js";

const CHILD_CONTINUATION_TOKEN = "subagent:private-token";

describe("createRuntimeActionRequestFromToolCall", () => {
  const loadSkillCall = {
    input: { skill: "research" },
    toolCallId: "call-skill",
    toolName: "load_skill",
    type: "tool-call" as const,
  };

  it("classifies the framework load_skill tool as a skill action", () => {
    expect(
      createRuntimeActionRequestFromToolCall({
        toolCall: loadSkillCall,
        tools: new Map([
          [
            "load_skill",
            {
              description: "Load a skill.",
              frameworkAction: "load-skill" as const,
              inputSchema: jsonSchema({ type: "object" }),
              name: "load_skill",
            },
          ],
        ]),
      }),
    ).toEqual({
      callId: "call-skill",
      input: { skill: "research" },
      kind: "load-skill",
    });
  });

  it("preserves workflow identity without changing observable action data", () => {
    const action = createRuntimeActionRequestFromToolCall({
      toolCall: {
        input: { service: "api" },
        toolCallId: "call-deploy",
        toolName: "deploy",
        type: "tool-call",
      },
      tools: new Map([
        [
          "deploy",
          {
            description: "Deploy.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "deploy",
            workflowId: "workflow//./agent/tools/deploy//execute",
          },
        ],
      ]),
    });

    expect(action).toEqual({
      callId: "call-deploy",
      input: { service: "api" },
      kind: "tool-call",
      toolName: "deploy",
    });
    expect(JSON.stringify(action)).toBe(
      '{"callId":"call-deploy","input":{"service":"api"},"kind":"tool-call","toolName":"deploy"}',
    );
    expect(isRuntimeWorkflowToolAction(action)).toBe(true);
  });

  it("uses the tool-authored label start callback without exposing it in event data", () => {
    const action = createPresentedRuntimeActionRequestFromToolCall({
      toolCall: {
        input: { environment: "production", secret: "hidden" },
        toolCallId: "call-deploy",
        toolName: "deploy",
        type: "tool-call",
      },
      tools: new Map([
        [
          "deploy",
          {
            label: {
              start: (input) =>
                `Deploy to ${String((input as { environment: unknown }).environment)}`,
            },
            description: "Deploy.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "deploy",
          },
        ],
      ]),
    });

    expect(action).toEqual({
      action: {
        callId: "call-deploy",
        input: { environment: "production", secret: "hidden" },
        kind: "tool-call",
        toolName: "deploy",
      },
      presentationLabel: "Deploy to production",
    });
  });

  it("does not let the label start callback callback mutate the action input", () => {
    const result = createPresentedRuntimeActionRequestFromToolCall({
      toolCall: {
        input: { nested: { value: "original" } },
        toolCallId: "call-mutate",
        toolName: "mutate",
        type: "tool-call",
      },
      tools: new Map([
        [
          "mutate",
          {
            label: {
              start: (input) => {
                const mutable = input as { nested: { value: string }; self?: unknown };
                mutable.nested.value = "changed";
                mutable.self = mutable;
                throw new Error("presentation failed");
              },
            },
            description: "Mutate.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "mutate",
          },
        ],
      ]),
    });

    expect(result).toEqual({
      action: {
        callId: "call-mutate",
        input: { nested: { value: "original" } },
        kind: "tool-call",
        toolName: "mutate",
      },
    });
  });

  it("ignores an label start callback callback that fails", () => {
    expect(
      createPresentedRuntimeActionRequestFromToolCall({
        toolCall: {
          input: {},
          toolCallId: "call-deploy",
          toolName: "deploy",
          type: "tool-call",
        },
        tools: new Map([
          [
            "deploy",
            {
              label: {
                start: () => {
                  throw new Error("presentation failed");
                },
              },
              description: "Deploy.",
              inputSchema: jsonSchema({ type: "object" }),
              name: "deploy",
            },
          ],
        ]),
      }),
    ).toEqual({
      action: { callId: "call-deploy", input: {}, kind: "tool-call", toolName: "deploy" },
    });
  });

  it("keeps an authored load_skill override as an ordinary tool action", () => {
    expect(
      createRuntimeActionRequestFromToolCall({
        toolCall: loadSkillCall,
        tools: new Map(),
      }),
    ).toEqual({
      callId: "call-skill",
      input: { skill: "research" },
      kind: "tool-call",
      toolName: "load_skill",
    });
  });
});

describe("createCoordinationRequestFromToolCall", () => {
  const toolCall = {
    input: { message: "research this" },
    toolCallId: "call-1",
    toolName: "researcher",
    type: "tool-call" as const,
  };

  it("lowers blocking workflow tools to workflow tasks", () => {
    expect(
      createCoordinationRequestFromToolCall({
        entry: { entryPoint: "execute" },
        input: toolCall.input,
        toolCall,
        tools: new Map([
          [
            "researcher",
            {
              description: "Delegate research.",
              inputSchema: jsonSchema({ type: "object" }),
              name: "researcher",
              workflowId: "workflow://subagent-tool",
            },
          ],
        ]),
      }),
    ).toEqual({
      callId: "call-1",
      executeInput: undefined,
      input: { message: "research this" },
      entry: { entryPoint: "execute" },
      kind: "workflow-task",
      toolName: "researcher",
      workflowId: "workflow://subagent-tool",
    });
  });
});

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", kind: "user", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingCoordinationBatch({
    tasks: [
      {
        callId: "call-1",
        executeInput: { message: "go", target: "researcher" },
        input: { description: "Research the topic", message: "go" },
        entry: { entryPoint: "execute" },
        kind: "workflow-task",
        toolName: "researcher",
        workflowId: "workflow://subagent-tool",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

describe("coordination batch identity", () => {
  it("rejects duplicate call ids before persisting the batch", () => {
    const task = {
      callId: "duplicate-call",
      entry: { entryPoint: "execute" as const },
      executeInput: { message: "go", target: "researcher" },
      input: { message: "go" },
      kind: "workflow-task" as const,
      toolName: "researcher",
      workflowId: "workflow://subagent-tool",
    };

    expect(() =>
      setPendingCoordinationBatch({
        tasks: [task, { ...task, toolName: "other" }],
        event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
        responseMessages: [],
        session: createParkedSession(),
      }),
    ).toThrow('duplicate callId "duplicate-call"');
  });
});

describe("resolvePendingCoordination", () => {
  it("forgets a finished workflow tool run and withdraws only its unanswered requests", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-1",
          input: { service: "api" },
          entry: { entryPoint: "execute" },
          kind: "workflow-task",
          toolName: "deploy",
          workflowId: "workflow//./agent/tools/deploy//execute",
        },
      ],
    });
    const withRun = registerWorkflowToolRun(parked, {
      callId: "call-1",
      toolName: "deploy",
      origin: { turnId: "turn_0", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "eve:workflow-tool-run:op-1" },
    });
    const answerToken = "eve:workflow-tool-run-answer:run-1:0";
    const session = upsertProxyInputRequests({
      entries: [
        ["other-request", { childContinuationToken: CHILD_CONTINUATION_TOKEN, kind: "question" }],
      ],
      forChildContinuationToken: CHILD_CONTINUATION_TOKEN,
      session: upsertProxyInputRequests({
        entries: [
          [
            answerToken,
            {
              answerHook: { runId: "run-1" },
              childContinuationToken: answerToken,
              kind: "question",
            },
          ],
        ],
        forChildContinuationToken: answerToken,
        session: withRun,
      }),
    });

    const resolved = await resolvePendingCoordination({
      session,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-1", kind: "tool-result", output: { deployed: true }, toolName: "deploy" },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getBlockingWorkflowToolRuns(resolved.session.state)).toEqual([]);
    expect([...getProxyInputRequests(resolved.session.state).keys()]).toEqual(["other-request"]);
  });

  it("projects a workflow tool's result through its toModelOutput", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-1",
          input: { service: "api" },
          entry: { entryPoint: "execute" },
          kind: "workflow-task",
          toolName: "deploy",
          workflowId: "workflow//./agent/tools/deploy//execute",
        },
      ],
    });
    const tools = new Map([
      [
        "deploy",
        {
          description: "Deploy.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "deploy",
          toModelOutput: (output: unknown) =>
            toolOutput.text(`deployed to ${(output as { url: string }).url}`),
        },
      ],
    ]);

    const resolved = await resolvePendingCoordination({
      session: parked,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "tool-result",
            output: { deployed: true, url: "https://api.example" },
            toolName: "deploy",
          },
        ],
      },
      tools,
    });

    const toolMessage = resolved.messages.at(-1);
    expect(toolMessage?.role).toBe("tool");
    expect(JSON.stringify(toolMessage?.content)).toContain("deployed to https://api.example");
    expect(JSON.stringify(toolMessage?.content)).not.toContain('"deployed":true');
  });
});

describe("resolveToolCallInputObject", () => {
  const context = { callId: "call-1", toolName: "web_search" };

  it("passes plain objects through", () => {
    expect(resolveToolCallInputObject({ query: "eve" }, context)).toEqual({ query: "eve" });
  });

  it("treats undefined, null, and empty-string inputs as empty arguments", () => {
    expect(resolveToolCallInputObject(undefined, context)).toEqual({});
    expect(resolveToolCallInputObject(null, context)).toEqual({});
    expect(resolveToolCallInputObject("", context)).toEqual({});
    expect(resolveToolCallInputObject("  ", context)).toEqual({});
  });

  it("parses raw JSON-string inputs from provider-executed tool calls", () => {
    expect(resolveToolCallInputObject('{"query":"eve"}', context)).toEqual({ query: "eve" });
  });

  it("rejects strings that are not JSON objects, naming the tool and call", () => {
    expect(() => resolveToolCallInputObject('"query"', context)).toThrow(
      /web_search.*call-1.*Expected a JSON-serializable object/su,
    );

    try {
      resolveToolCallInputObject("not json", context);
      expect.unreachable("malformed JSON should throw");
    } catch (error) {
      expect(error).toMatchObject({
        cause: expect.objectContaining({ name: "SyntaxError" }),
      });
      expect((error as Error).message).toMatch(/web_search.*call-1/su);
      expect((error as Error).message).not.toContain("Expected a JSON-serializable object.");
    }
  });

  it("rejects non-object JSON values", () => {
    expect(() => resolveToolCallInputObject(42, context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
    expect(() => resolveToolCallInputObject(["a"], context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
  });
});
import { jsonSchema } from "ai";

import { describe, expect, it } from "vitest";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import {
  assertUniqueCoordinationCallIds,
  createCoordinationRequestFromToolCall,
  createRuntimeActionRequestFromToolCall,
  forgetFinishedRuns,
  resolveToolCallInputObject,
  runtimeResultCalls,
} from "#harness/coordination.js";
import {
  getBlockingWorkflowToolRuns,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";

import { toolOutput } from "#tools/model-output.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/hitl/session-state.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { isRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { createPreparedWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";

const REQUEST_EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

const CHILD_CONTINUATION_TOKEN = "subagent:private-token";

describe("createRuntimeActionRequestFromToolCall", () => {
  it.each(["subagent", "remote"] as const)(
    "retains %s dispatch identity for a background agent tool",
    (kind) => {
      const target =
        kind === "remote"
          ? {
              kind: "remote-agent-call" as const,
              remoteAgentName: "reviewer",
              nodeId: "reviewer-node",
            }
          : { kind: "subagent-call" as const, subagentName: "reviewer", nodeId: "reviewer-node" };
      const prepared: PreparedRuntimeDelegationTool = {
        kind,
        name: "reviewer",
        nodeId: "reviewer-node",
        logicalPath: "subagents/reviewer",
        sourceId: "reviewer",
        description: "Review a draft.",
        inputSchema: { type: "object" },
        behavior: { availability: [], handling: { kind: "dispatch", target } },
      };
      const tool = createPreparedWorkflowToolHarnessDefinition(prepared);
      const action = createRuntimeActionRequestFromToolCall({
        toolCall: {
          input: { message: "Review Alice's draft." },
          toolCallId: "review",
          toolName: "reviewer",
        },
        tools: new Map([["reviewer", tool]]),
      });
      expect(action).toMatchObject({
        kind: target.kind,
        nodeId: "reviewer-node",
        name: "reviewer",
      });
    },
  );

  it("preserves workflow identity without changing observable action data", () => {
    const action = createRuntimeActionRequestFromToolCall({
      toolCall: {
        input: { service: "api" },
        toolCallId: "call-deploy",
        toolName: "deploy",
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
      action: {
        callId: "call-deploy",
        input: {},
        kind: "tool-call",
        toolName: "deploy",
      },
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

  return withUsage;
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

    expect(() => assertUniqueCoordinationCallIds([task, { ...task, toolName: "other" }])).toThrow(
      'duplicate callId "duplicate-call"',
    );
  });
});

describe("runtime results", () => {
  it("forgets a finished workflow tool run and names only its requests for withdrawal", () => {
    const withRun = registerWorkflowToolRun(createParkedSession(), {
      callId: "call-1",
      toolName: "deploy",
      origin: { turnId: "turn_0", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "eve:workflow-tool-run:op-1" },
    });
    const answerToken = "eve:workflow-tool-run-answer:run-1:0";
    const session = upsertProxyInputRequests({
      entries: [
        [
          "other-request",
          {
            childContinuationToken: CHILD_CONTINUATION_TOKEN,
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: CHILD_CONTINUATION_TOKEN,
      session: upsertProxyInputRequests({
        entries: [
          [
            answerToken,
            {
              runId: "run-1",
              workflowAsk: { control: "control" },
              reply: {},
              childContinuationToken: answerToken,
              event: REQUEST_EVENT,
              kind: "question",
            },
          ],
        ],
        forChildContinuationToken: answerToken,
        session: withRun,
      }),
    });

    const finished = forgetFinishedRuns(
      session,
      [{ callId: "call-1", kind: "tool-result", output: { deployed: true }, toolName: "deploy" }],
      "turn_0",
    );

    expect(getBlockingWorkflowToolRuns(finished.session.state)).toEqual([]);
    expect(finished.requestIds).toEqual([answerToken]);
    expect([...getProxyInputRequests(finished.session.state).keys()]).toContain("other-request");
  });

  it("projects a workflow tool's result through its toModelOutput", async () => {
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

    const [settled] = await runtimeResultCalls(
      [
        {
          callId: "call-1",
          kind: "tool-result",
          output: { deployed: true, url: "https://api.example" },
          toolName: "deploy",
        },
      ],
      tools,
    );

    expect(JSON.stringify(settled?.part.output)).toContain("deployed to https://api.example");
    expect(JSON.stringify(settled?.part.output)).not.toContain('"deployed":true');
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

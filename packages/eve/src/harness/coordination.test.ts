import { describe, expect, it } from "vitest";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import {
  createCoordinationRequestFromToolCall,
  createRuntimeActionRequestFromToolCall,
  getPendingCoordinationBatch,
  resolvePendingCoordination,
  resolveToolCallInputObject,
  setPendingCoordinationBatch,
} from "#harness/coordination.js";

import { toolOutput, toolOutputPart } from "#tools/model-output.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { isRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { renderTaskResults, truncateTaskResult } from "#tasks/render.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";

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
      kind: "workflow-task",
      toolName: "researcher",
      workflowId: "workflow://subagent-tool",
    });
  });

  it("carries a workflow tool's attached option onto its task", () => {
    expect(
      createCoordinationRequestFromToolCall({
        toolCall: { ...toolCall, toolName: "lookup" },
        tools: new Map([
          [
            "lookup",
            {
              attached: true,
              description: "Look up an order.",
              inputSchema: jsonSchema({ type: "object" }),
              name: "lookup",
              workflowId: "workflow//./agent/tools/lookup//execute",
            },
          ],
        ]),
      }),
    ).toMatchObject({ attached: true, toolName: "lookup" });
  });

  it("rejects a deferred tool without a workflow", () => {
    expect(() => createCoordinationRequestFromToolCall({ toolCall, tools: new Map() })).toThrow(
      'Deferred tool "researcher" has no workflow task.',
    );
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
  it("resolves a workflow tool call", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-1",
          input: { service: "api" },
          kind: "workflow-task",
          toolName: "deploy",
          workflowId: "workflow//./agent/tools/deploy//execute",
        },
      ],
    });

    const resolved = await resolvePendingCoordination({
      session: parked,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-1", kind: "tool-result", output: { deployed: true }, toolName: "deploy" },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getPendingCoordinationBatch(resolved.session.state)).toBeUndefined();
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

  it("truncates the text parts of a content result under one shared limit", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-1",
          input: {},
          kind: "workflow-task",
          toolName: "screenshot",
          workflowId: "workflow//./agent/tools/screenshot//execute",
        },
      ],
    });
    const page = Array.from({ length: 30 }, () => "p".repeat(1000)).join("\n");
    const tools = new Map([
      [
        "screenshot",
        {
          description: "Screenshot.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "screenshot",
          toModelOutput: () =>
            toolOutput.content([
              toolOutputPart.text(page),
              toolOutputPart.file("aGVsbG8=", { mediaType: "image/png" }),
              toolOutputPart.text(page),
              toolOutputPart.text(page),
            ]),
        },
      ],
    ]);

    const resolved = await resolvePendingCoordination({
      session: parked,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-1", kind: "tool-result", output: "ok", toolName: "screenshot" },
        ],
      },
      tools,
    });

    const [part] = resolved.messages.at(-1)!.content as readonly {
      readonly output: {
        readonly type: string;
        readonly value: readonly { readonly type: string; readonly text?: string }[];
      };
    }[];
    const texts = part!.output.value.flatMap((entry) =>
      entry.type === "text" ? [entry.text!] : [],
    );
    // Each page fits alone; together they pass 50 KB, so the third page is dropped.
    expect(texts).toHaveLength(2);
    expect(texts[1]!.endsWith("\n[truncated]")).toBe(true);
    expect(Buffer.byteLength(texts.join("\n"))).toBeLessThanOrEqual(
      50 * 1024 + "\n[truncated]".length,
    );
    // Parts that are not text are kept.
    expect(part!.output.value.map((entry) => entry.type)).toEqual(["text", "file", "text"]);
  });

  it("shows the model a receipt's text instead of projecting its output", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-1",
          input: {},
          kind: "workflow-task",
          toolName: "remind",
          workflowId: "workflow//./agent/tools/remind//execute",
        },
      ],
    });
    const emitted: unknown[] = [];

    const resolved = await resolvePendingCoordination({
      emit: async (event) => {
        emitted.push(event);
      },
      session: parked,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "tool-result",
            modelOutput: "Task remind-q4x1ze is working.",
            output: { status: "working", taskId: "remind-q4x1ze" },
            toolName: "remind",
          },
        ],
      },
      tools: new Map([
        [
          "remind",
          {
            description: "Remind.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "remind",
            toModelOutput: () => toolOutput.text("never applied to a receipt"),
          },
        ],
      ]),
    });

    expect(resolved.messages.at(-1)?.content).toEqual([
      {
        output: { type: "text", value: "Task remind-q4x1ze is working." },
        toolCallId: "call-1",
        toolName: "remind",
        type: "tool-result",
      },
    ]);
    // Clients read the structured receipt; the model text stays off the stream.
    expect(emitted).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          result: {
            callId: "call-1",
            kind: "tool-result",
            output: { status: "working", taskId: "remind-q4x1ze" },
            toolName: "remind",
          },
        }),
        type: "action.result",
      }),
    ]);
  });

  it("shows a settled task_wait as the task's <task_result> block, shaped by its tool", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-wait",
          input: { taskId: "remind-q4x1ze" },
          kind: "workflow-task",
          toolName: "task_wait",
          workflowId: TASK_WAIT_WORKFLOW_ID,
        },
      ],
    });
    const output = {
      name: "remind",
      outcome: { output: { note: "stand-up at 10" }, status: "completed" },
      status: "settled",
      taskId: "remind-q4x1ze",
    };

    const resolved = await resolvePendingCoordination({
      session: parked,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-wait", kind: "tool-result", output, toolName: "task_wait" },
        ],
      },
      tools: new Map<string, HarnessToolDefinition>([
        [
          "remind",
          {
            description: "Remind.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "remind",
            toModelOutput: (value) =>
              toolOutput.text(`Reminder: ${(value as { note: string }).note}`),
          },
        ],
        [
          "task_wait",
          {
            description: "Wait.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "task_wait",
            workflowId: TASK_WAIT_WORKFLOW_ID,
          },
        ],
      ]),
    });

    expect(resolved.messages.at(-1)?.content).toEqual([
      {
        output: {
          type: "text",
          value:
            '<task_result id="remind-q4x1ze" tool="remind" status="completed">\nReminder: stand-up at 10\n</task_result>',
        },
        toolCallId: "call-wait",
        toolName: "task_wait",
        type: "tool-result",
      },
    ]);
  });

  it("shows a settled task_wait the raw output when the tool's toModelOutput throws, as task.result does", async () => {
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-wait",
          input: { taskId: "remind-q4x1ze" },
          kind: "workflow-task",
          toolName: "task_wait",
          workflowId: TASK_WAIT_WORKFLOW_ID,
        },
      ],
    });
    const outcome = { output: { note: "stand-up at 10" }, status: "completed" } as const;

    const resolved = await resolvePendingCoordination({
      session: parked,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-wait",
            kind: "tool-result",
            output: { name: "remind", outcome, status: "settled", taskId: "remind-q4x1ze" },
            toolName: "task_wait",
          },
        ],
      },
      tools: new Map<string, HarnessToolDefinition>([
        [
          "remind",
          {
            description: "Remind.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "remind",
            toModelOutput: () => {
              throw new Error("The reminder formatter is broken.");
            },
          },
        ],
        [
          "task_wait",
          {
            description: "Wait.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "task_wait",
            workflowId: TASK_WAIT_WORKFLOW_ID,
          },
        ],
      ]),
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.messages.at(-1)?.content).toEqual([
      expect.objectContaining({
        output: {
          type: "text",
          value: renderTaskResults([
            { body: undefined, outcome, record: { id: "remind-q4x1ze", name: "remind" } },
          ]),
        },
        toolCallId: "call-wait",
      }),
    ]);
  });

  it("accepts a dispatch-origin failure result by callId", async () => {
    const resolved = await resolvePendingCoordination({
      session: createParkedSession(),
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            origin: "dispatch",
            output: { code: "START_FAILED", message: "boom" },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getPendingCoordinationBatch(resolved.session.state)).toBeUndefined();
  });

  it("emits only the action result for a settled agent call", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    const resolved = await resolvePendingCoordination({
      emit: async (event) => {
        events.push(event);
      },
      session: createParkedSession(),
      stepInput: {
        runtimeActionResults: [
          { callId: "call-1", kind: "tool-result", output: "done", toolName: "researcher" },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(events.map((event) => event.type)).toEqual(["action.result"]);
  });

  it("shows the model a waited task's result under the <task_result> limit, and clients all of it", async () => {
    const answer = Array.from({ length: 2500 }, (_, index) => `finding ${String(index)}`).join(
      "\n",
    );
    const report = { findings: Array.from({ length: 2500 }, (_, index) => index) };
    const events: UnstampedMessageStreamEvent[] = [];
    const parked = setPendingCoordinationBatch({
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      tasks: [
        {
          callId: "call-agent",
          input: {},
          kind: "workflow-task",
          toolName: "researcher",
          workflowId: "workflow//./agent/tools/researcher//execute",
        },
        {
          callId: "call-report",
          input: {},
          kind: "workflow-task",
          toolName: "report",
          workflowId: "workflow//./agent/tools/report//execute",
        },
        {
          callId: "call-small",
          input: {},
          kind: "workflow-task",
          toolName: "deploy",
          workflowId: "workflow//./agent/tools/deploy//execute",
        },
      ],
    });

    const resolved = await resolvePendingCoordination({
      emit: async (event) => {
        events.push(event);
      },
      session: parked,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-agent", kind: "tool-result", output: answer, toolName: "researcher" },
          { callId: "call-report", kind: "tool-result", output: report, toolName: "report" },
          {
            callId: "call-small",
            kind: "tool-result",
            output: { deployed: true },
            toolName: "deploy",
          },
        ],
      },
    });

    const parts = resolved.messages.at(-1)?.content as readonly {
      readonly output: { readonly type: string; readonly value: unknown };
    }[];
    const truncatedAnswer = truncateTaskResult(answer);
    expect(truncatedAnswer.endsWith("finding 1999\n[truncated]")).toBe(true);
    expect(parts[0]?.output).toEqual({ type: "text", value: truncatedAnswer });
    // Structured output past the limit reaches the model as its truncated JSON text.
    expect(parts[1]?.output).toEqual({
      type: "text",
      value: truncateTaskResult(JSON.stringify(report, null, 2)),
    });
    // Structured output within the limit stays structured.
    expect(parts[2]?.output).toEqual({ type: "json", value: { deployed: true } });
    expect(
      events.map((event) => event.type === "action.result" && event.data.result.output),
    ).toEqual([answer, report, { deployed: true }]);
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

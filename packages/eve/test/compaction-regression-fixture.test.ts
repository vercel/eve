import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MockModelRequest, MockModelResponder } from "../src/evals/mock-model.js";

const { respond } = vi.hoisted(() => ({ respond: vi.fn<MockModelResponder>() }));

vi.mock("eve", () => ({
  defineAgent: (config: unknown) => config,
}));

vi.mock("eve/evals", () => ({
  defineEval: (config: unknown) => config,
  mockModel: (config: { respond: MockModelResponder }) => {
    respond.mockImplementation(config.respond);
    return {};
  },
}));

vi.mock("eve/tools", () => ({
  defineTool: (config: unknown) => config,
}));

vi.mock("eve/context", () => ({
  defineState: vi.fn(),
}));

vi.mock("eve/tools/todo", () => ({
  todo: { execute: vi.fn() },
}));

vi.mock("../../../e2e/fixtures/e2e-config/src/index.ts", () => ({
  e2eAgentConfig: () => ({}),
  e2eModel: () => "fixture/compaction-model",
}));

// Load the authored fixture without absorbing its workspace into eve's TypeScript root.
const fixture = new URL("../../../e2e/fixtures/agent-compaction-regressions/", import.meta.url);

function request(messages: MockModelRequest["messages"]): MockModelRequest {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
  return {
    messages,
    userMessages,
    lastUserMessage: userMessages.at(-1) ?? null,
    userMessageCount: userMessages.length,
    toolResults: [],
    tools: [],
  };
}

describe("compaction regression fixture", () => {
  beforeEach(async () => {
    vi.resetModules();
    await import(new URL("agent/agent.ts", fixture).pathname);
  });

  it("accepts the requested approach and rejects mismatched attempts", async () => {
    const { inputSchema } = (
      await import(new URL("agent/tools/perform-source-analysis.ts", fixture).pathname)
    ).default;

    expect(inputSchema.safeParse({ approach: "initial" }).success).toBe(true);
    expect(inputSchema.safeParse({ approach: "attempt-1" }).success).toBe(false);
  });

  it("performs the exact requested analysis before advancing past a stale todo", async () => {
    const definition = (await import(new URL("evals/stale-todo-work.eval.ts", fixture).pathname))
      .default;
    const sent = vi.fn(async (_message: string) => {
      throw new Error("Captured fixture request");
    });
    await expect(definition.test({ send: sent })).rejects.toThrow("Captured fixture request");
    const task = sent.mock.calls[0]![0];
    expect(task).toContain("approach initial");
    const taskMessage = { role: "user" as const, text: task };

    const analysis = await respond(request([taskMessage]));
    expect(analysis).toEqual({
      usage: { inputTokens: 4_096 },
      toolCalls: [
        {
          id: "perform-source-analysis-1",
          input: { approach: "initial" },
          name: "perform-source-analysis",
        },
      ],
    });

    const preservedTodo = {
      role: "user" as const,
      text: "[Your task list was preserved across context compaction]\n- [ ] [high] Complete source analysis",
    };
    const checkpoint = [
      { role: "user" as const, text: "Summary of our conversation so far:" },
      {
        role: "assistant" as const,
        text: "Alice's analysis is pending. Use approach initial, then record Bob's handoff.",
      },
    ];
    const advance = await respond(
      request([
        ...checkpoint,
        {
          role: "tool",
          text: JSON.stringify({
            completed: true,
            completionMarker: "SOURCE_ANALYSIS_COMPLETE",
            approach: "initial",
          }),
        },
        taskMessage,
        preservedTodo,
      ]),
    );
    expect(advance).toEqual({
      usage: { inputTokens: 4_096 },
      toolCalls: [
        {
          id: "advance-checkpoint-1",
          input: { regressionCase: "stale-todo-work" },
          name: "advance-checkpoint",
        },
      ],
    });

    const completed = await respond(
      request([
        checkpoint[0]!,
        {
          role: "assistant",
          text: "Alice's analysis is complete: SOURCE_ANALYSIS_COMPLETE. Bob's handoff notes are recorded: SECOND_CHECKPOINT_READY.",
        },
        taskMessage,
        preservedTodo,
      ]),
    );
    expect(completed).toBe("Done: SOURCE_ANALYSIS_COMPLETE; SECOND_CHECKPOINT_READY");
  });
});

import { expect, it } from "vitest";
import { v4ToV5 } from "./v4-to-v5.js";

it("removes token cost without changing tokens or application data", () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.25,
  };
  const payload = {
    adapterData: { costUsd: 99 },
    task: {
      views: [
        {
          taskId: "task-1",
          status: "working" as const,
          metadata: { kind: "subagent", name: "research" },
          usage,
        },
      ],
    },
  };
  const wire = v4ToV5.down({ kind: "deliver", version: 5, payload, payloads: [payload] });
  expect(wire).toMatchObject({
    version: 4,
    payload: {
      adapterData: { costUsd: 99 },
      task: { views: [{ usage: { inputTokens: 10, outputTokens: 2 } }] },
    },
  });
  if (wire.kind !== "deliver") throw new Error("Expected delivery");
  expect(wire.payload.task?.views?.[0]?.usage).not.toHaveProperty("costUsd");
  expect(usage.costUsd).toBe(0.25);
});

it("removes cost from child usage while preserving the child's result", () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.25,
  };
  const payload = {
    task: {
      agentRequests: [
        {
          taskId: "task-1",
          replyTo: "reply",
          request: {
            kind: "agent-settled" as const,
            result: {
              kind: "subagent-result" as const,
              origin: "child" as const,
              callId: "call-1",
              subagentName: "research",
              output: { costUsd: 99 },
              usage,
              outcome: {
                kind: "terminal" as const,
                result: { kind: "succeeded" as const, output: "done" },
                usageDelta: usage,
              },
            },
          },
        },
      ],
    },
  };
  const wire = v4ToV5.down({ kind: "deliver", version: 5, payload, payloads: [payload] });
  if (wire.kind !== "deliver") throw new Error("Expected delivery");
  const request = wire.payload.task?.agentRequests?.[0]?.request;
  if (request?.kind !== "agent-settled") throw new Error("Expected child result");
  expect(request.result.usage).not.toHaveProperty("costUsd");
  expect(request.result.outcome.usageDelta).not.toHaveProperty("costUsd");
  expect(request.result.output).toEqual({ costUsd: 99 });
});

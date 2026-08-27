import { describe, expect, it, vi } from "vitest";

import type { RuntimeSubagentResult } from "#shared/action-types.js";
import { subagentToolExecuteWorkflow } from "#execution/tools/subagent/workflow.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import type { ToolContext } from "#tools/definition.js";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: vi.fn(),
  disposeHook: vi.fn(),
}));
vi.mock("#execution/tool-run/workflow-api.js", () => ({ resumeHook: vi.fn() }));

describe("subagentToolExecuteWorkflow", () => {
  it("preserves the child result when hook disposal fails", async () => {
    const result: RuntimeSubagentResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: "dispatch failed",
      subagentName: "research",
    };
    mocks.createHook.mockReturnValue(
      asyncIterable([{ kind: "runtime-action-result", results: [result] }]),
    );
    vi.mocked(claimHookOwnership).mockResolvedValue(undefined);
    vi.mocked(disposeHook).mockRejectedValue(new Error("dispose failed"));

    await expect(subagentToolExecuteWorkflow({}, context())).resolves.toBe(result);
  });
});

function context(): ToolContext {
  const ctx = {
    callId: "call-1",
    toolName: "research",
  } as ToolContext;
  Object.defineProperty(ctx, Symbol.for("eve.subagent-tool-run"), {
    value: { replyToken: "reply-hook", subagentName: "research" },
  });
  return ctx;
}

function asyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

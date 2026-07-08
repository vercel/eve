import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

const startSpanMock = vi.fn();
const endSpanMock = vi.fn();

vi.mock("#compiled/@opentelemetry/api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#compiled/@opentelemetry/api/index.js")>();
  return {
    ...actual,
    trace: {
      getTracer: () => ({
        startSpan: (name: string, options: unknown) => {
          startSpanMock(name, options);
          return { end: endSpanMock };
        },
      }),
    },
  };
});

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };

function subagentResult(
  overrides: Partial<Extract<RuntimeActionResult, { kind: "subagent-result" }>> = {},
): RuntimeActionResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    output: "done",
    subagentName: "research",
    ...overrides,
  };
}

describe("recordSubagentUsageSpans", () => {
  beforeEach(() => {
    startSpanMock.mockReset();
    endSpanMock.mockReset();
  });

  it("emits one invoke_agent span per successful result with usage", () => {
    recordSubagentUsageSpans([
      subagentResult({ usage: USAGE }),
      subagentResult({ callId: "call-2", subagentName: "writer", usage: USAGE }),
    ]);

    expect(startSpanMock).toHaveBeenCalledTimes(2);
    expect(startSpanMock).toHaveBeenCalledWith("invoke_agent research", {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "research",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.usage.cache_read.input_tokens": 10,
        "gen_ai.usage.cache_creation.input_tokens": 5,
      },
    });
    expect(endSpanMock).toHaveBeenCalledTimes(2);
  });

  it("skips results without usage, error results, and non-subagent kinds", () => {
    recordSubagentUsageSpans([
      subagentResult(),
      subagentResult({ isError: true, usage: USAGE }),
      {
        callId: "call-3",
        kind: "tool-result",
        output: "ok",
        toolName: "search",
      },
    ]);

    expect(startSpanMock).not.toHaveBeenCalled();
  });

  it("does not throw when the tracer fails", () => {
    startSpanMock.mockImplementation(() => {
      throw new Error("tracer unavailable");
    });

    expect(() => {
      recordSubagentUsageSpans([subagentResult({ usage: USAGE })]);
    }).not.toThrow();
  });
});

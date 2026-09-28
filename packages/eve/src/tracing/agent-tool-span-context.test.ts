import { ROOT_CONTEXT } from "#compiled/@opentelemetry/api/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  agentToolContentPolicy,
  annotateAgentToolSpan,
  recordAgentToolSpanError,
  withAgentToolContentPolicy,
  withAgentToolSpanContext,
} from "#tracing/agent-tool-span-context.js";

describe("agent tool span context", () => {
  it("narrows the capture policy without dropping the span writer", () => {
    const setAttributes = vi.fn();
    const recordError = vi.fn();
    const context = withAgentToolSpanContext(ROOT_CONTEXT, {
      recordError,
      recordInputs: true,
      recordOutputs: true,
      setAttributes,
    });
    const narrowed = withAgentToolContentPolicy(context, {
      recordInputs: false,
      recordOutputs: false,
    });

    expect(agentToolContentPolicy(narrowed)).toEqual({
      recordInputs: false,
      recordOutputs: false,
    });
    expect(annotateAgentToolSpan({ "mcp.method.name": "tools/call" }, narrowed)).toBe(true);
    recordAgentToolSpanError(new Error("private result"), "tool_error", narrowed);

    expect(setAttributes).toHaveBeenCalledWith({ "mcp.method.name": "tools/call" });
    expect(recordError).toHaveBeenCalledWith(undefined, "tool_error");
  });
});

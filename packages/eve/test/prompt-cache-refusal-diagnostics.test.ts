import { describe, expect, it, vi } from "vitest";

vi.mock("eve/instrumentation", () => ({
  defineInstrumentation: (definition: unknown) => definition,
}));

const fixture = new URL(
  "../../../e2e/fixtures/agent-prompt-cache/agent/instrumentation/refusal-diagnostics.ts",
  import.meta.url,
);
const { default: diagnostics } = await import(fixture.pathname);
const scope = { sessionId: "session_1", turnId: "turn_1", stepIndex: 0, attemptIndex: 0 };

describe("prompt-cache refusal diagnostics", () => {
  it("records only bounded refusal codes and attempt coordinates", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      diagnostics.events["step.attempt.metadata"]({
        type: "step.attempt.metadata",
        scope,
        providerMetadata: {
          anthropic: {
            stopDetails: {
              type: "refusal",
              category: "reasoning_extraction",
              explanation: "PRIVATE_PROVIDER_EXPLANATION",
            },
            signature: "PRIVATE_REASONING_SIGNATURE",
          },
          gateway: { generationId: "gen_123", authorization: "PRIVATE_CREDENTIAL" },
        },
      });
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0]![1])).toEqual({
        event: "step.attempt.metadata",
        providerStopType: "refusal",
        providerStopCategory: "reasoning_extraction",
        generationId: "gen_123",
        ...scope,
      });
      expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE");
    } finally {
      output.mockRestore();
    }
  });

  it("reports filtered calls without persisting their content", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      diagnostics.events["model.call.completed"]({
        type: "model.call.completed",
        finishReason: "content-filter",
        content: [{ type: "reasoning", text: "PRIVATE_REASONING" }],
        scope,
      });
      expect(JSON.parse(output.mock.calls[0]![1])).toEqual({
        event: "model.call.completed",
        finishReason: "content-filter",
        ...scope,
      });
      expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE");
    } finally {
      output.mockRestore();
    }
  });

  it("ignores successful calls and rejects free-form or oversized metadata", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      diagnostics.events["model.call.completed"]({ finishReason: "stop", scope });
      diagnostics.events["step.attempt.metadata"]({ providerMetadata: {}, scope });
      expect(output).not.toHaveBeenCalled();
      diagnostics.events["step.attempt.metadata"]({
        type: "step.attempt.metadata",
        scope,
        providerMetadata: {
          anthropic: { stopDetails: { type: "refusal", category: "private text\n" } },
          gateway: { generationId: "x".repeat(129) },
        },
      });
      const result = JSON.parse(output.mock.calls[0]![1]);
      expect(result).not.toHaveProperty("providerStopCategory");
      expect(result).not.toHaveProperty("generationId");
    } finally {
      output.mockRestore();
    }
  });
});

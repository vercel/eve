import { describe, expect, it } from "vitest";

import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { redactSpanInputs, redactSpanOutputs } from "#tracing/span-export-policy.js";

function destination(): SpanProcessor & { readonly ended: unknown[] } {
  const ended: unknown[] = [];
  return {
    ended,
    forceFlush: async () => undefined,
    onEnd: (span) => {
      ended.push(span);
    },
    onStart: () => undefined,
    shutdown: async () => undefined,
  };
}

describe("destination export policy isolation", () => {
  it("delivers different views of the same admitted span without mutating it", () => {
    const inputRedacted = destination();
    const outputRedacted = destination();
    const original = {
      attributes: {
        "agent.channel.audience": "private",
        "ai.prompt.messages": "private input",
        "ai.response.text": "private output",
      },
      spanContext: () => ({ spanId: "1".repeat(16), traceId: "2".repeat(32) }),
    };

    contentFilteringProcessor(inputRedacted, redactSpanInputs()).onEnd(original);
    contentFilteringProcessor(outputRedacted, redactSpanOutputs()).onEnd(original);

    expect((inputRedacted.ended[0] as { attributes: Record<string, unknown> }).attributes).toEqual({
      "agent.channel.audience": "private",
      "ai.response.text": "private output",
    });
    expect((outputRedacted.ended[0] as { attributes: Record<string, unknown> }).attributes).toEqual(
      {
        "agent.channel.audience": "private",
        "ai.prompt.messages": "private input",
      },
    );
    expect(original.attributes).toEqual({
      "agent.channel.audience": "private",
      "ai.prompt.messages": "private input",
      "ai.response.text": "private output",
    });
  });
});

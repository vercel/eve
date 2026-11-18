import { describe, expect, it } from "vitest";

import { GenerationSteering } from "#harness/generation-steering.js";
import type { SessionEvent } from "#protocol/session-event.js";

function steeredAfter(event: SessionEvent): boolean {
  const steering = new AbortController();
  const generation = new GenerationSteering({ steeringSignal: steering.signal });
  generation.begin();
  generation.beforeEvent(event);
  steering.abort();
  generation.dispose();
  return generation.interrupted;
}

describe("GenerationSteering", () => {
  it("cuts a generation that has published nothing a reader keeps", () => {
    expect(
      steeredAfter({
        data: { delta: "Thinking", kind: "reasoning", partId: "r" },
        type: "content.delta",
      }),
    ).toBe(true);
  });

  it("keeps a generation streaming a tool call's input", () => {
    expect(
      steeredAfter({ data: { callId: "call_0", delta: '{"contents":' }, type: "call.input" }),
    ).toBe(false);
  });
});

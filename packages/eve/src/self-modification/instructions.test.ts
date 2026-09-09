import { afterEach, describe, expect, it } from "vitest";

import instructions from "./extension/instructions.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("self-modification instructions", () => {
  const ctx = {
    channel: {},
    messages: [],
    session: { auth: { current: null, initiator: null }, id: "selfmod" },
  };

  it("points at the trace that invoked selfmod", () => {
    process.env.EVE_DEV = "1";
    const traceId = "a".repeat(32);
    const definition = instructions.events["session.started"]?.(
      {
        data: { trace: { spanId: "b".repeat(16), traceFlags: 1, traceId } },
        type: "session.started",
      },
      ctx,
    );

    expect(definition).toMatchObject({
      markdown: expect.stringContaining(`invoking trace has ID ${traceId}`),
    });
    expect(definition).toMatchObject({ markdown: expect.stringContaining(`/traces/${traceId}`) });
  });

  it("does not claim that trace coordinates guarantee local segments", () => {
    process.env.EVE_DEV = "1";
    const traceId = "a".repeat(32);
    const definition = instructions.events["session.started"]?.(
      {
        data: { trace: { spanId: "b".repeat(16), traceFlags: 0, traceId } },
        type: "session.started",
      },
      ctx,
    );

    expect(definition).toMatchObject({
      markdown: expect.stringContaining("not sampled, so local segments may be absent"),
    });
  });
});

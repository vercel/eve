import { describe, expect, it, vi } from "vitest";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(async () => ({
    get: () => undefined,
    require: () => ({ turnAgent: { id: "test-agent" } }),
  })),
}));
vi.mock("#instrumentation/runtime.js", () => ({
  bindSessionInstrumentation: vi.fn(() => ({
    createHandleEvent: ({ handleEvent }: { handleEvent: (event: unknown) => Promise<void> }) =>
      handleEvent,
    flush: async () => {},
  })),
}));

import { emitTerminalSessionEvent } from "#execution/terminal-session-event.js";
import { createSessionFailedEvent } from "#protocol/message.js";

describe("emitTerminalSessionEvent", () => {
  it("closes the durable stream after emitting a terminal failure", async () => {
    let closed = false;
    const parentWritable = new WritableStream<Uint8Array>({
      close() {
        closed = true;
      },
    });

    await emitTerminalSessionEvent({
      event: createSessionFailedEvent({
        code: "WORKFLOW_EXECUTION_FAILED",
        message: "failed",
        sessionId: "session_xyz",
      }),
      parentWritable,
      serializedContext: { "eve.sessionId": "session_xyz" },
    });

    expect(closed).toBe(true);
  });
});

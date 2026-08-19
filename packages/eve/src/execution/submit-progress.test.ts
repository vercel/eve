import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ProgressCallbackKey, SessionKey } from "#context/keys.js";
import { submitProgressCommand } from "#execution/submit-progress.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({ resumeHook: vi.fn() }));

const command = { commandId: "one", events: [], kind: "progress" as const, version: 1 as const };

function context() {
  const context = new ContextContainer();
  context.set(SessionKey, {
    auth: { current: null, initiator: null },
    parent: {
      callId: "call",
      rootSessionId: "root",
      sessionId: "parent",
      turn: { id: "turn", sequence: 0 },
    },
    sessionId: "child",
    turn: { id: "child-turn", sequence: 0 },
  });
  return context;
}

describe("submitProgressCommand", () => {
  it("routes local descendants to the root session inbox", async () => {
    await submitProgressCommand(context(), command);
    expect(resumeHook).toHaveBeenCalledWith("eve:session:root:inbox", command);
  });

  it("uses the inherited callback and throws on transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const ctx = context();
    ctx.set(ProgressCallbackKey, {
      token: "root-token",
      url: "https://root.example.com/eve/v1/callback/root-token",
      version: 1,
    });
    await expect(submitProgressCommand(ctx, command)).rejects.toThrow("HTTP 503");
  });
});

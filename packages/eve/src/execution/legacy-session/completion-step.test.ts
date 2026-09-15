import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { completeLegacyDriverStep } from "./completion-step.js";
import type { PreparedLegacySession } from "./prepare-step.js";
import { importConversation } from "./snapshot.js";
const { resume } = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: resume }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const close = vi.fn();
  const session = {
    sessionId: "old",
    continuationToken: "",
    history: [],
    agent: { system: "old" },
  };
  const prepared: PreparedLegacySession = {
    originalSession: session,
    sessionState: importConversation(session),
    serializedContext: {},
    sessionTimeoutMs: false,
    hooks: { stable: "current", aliases: [] },
    deploymentId: "new",
    input: {
      retention: undefined,
      completionToken: "old:completion",
      mode: "task",
      inputCommitted: false,
      delivery: { kind: "deliver", payloads: [] },
      parentWritable: new WritableStream({ close }),
      serializedContext: { "eve.sessionCallback": { url: "https://example.com/callback" } },
      sessionState: { sessionId: "old" },
    },
  };
  return { close, prepared };
}
describe("original driver finalization", () => {
  it("closes the original stream and sends one historical completion with the original callback context", async () => {
    const { prepared, close } = fixture();
    const result = {
      output: "failed",
      isError: true,
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    await completeLegacyDriverStep({ prepared, result });
    expect(close).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledExactlyOnceWith("old:completion", {
      kind: "turn-result",
      action: {
        kind: "done",
        ...result,
        serializedContext: prepared.input.serializedContext,
        sessionState: {
          ...prepared.sessionState,
          snapshot: { version: 1, session: prepared.sessionState.snapshot.session },
        },
      },
    });
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(resume.mock.invocationCallOrder[0]!);
  });
  it("tolerates an already-finished original driver", async () => {
    const { prepared } = fixture();
    resume.mockRejectedValue(new HookNotFoundError("old:completion"));
    await expect(
      completeLegacyDriverStep({ prepared, result: { output: "" } }),
    ).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledOnce();
  });
  it("surfaces uncertain completion writes for durable step retry", async () => {
    const { prepared } = fixture();
    resume.mockRejectedValue(new Error("wake failed"));
    await expect(completeLegacyDriverStep({ prepared, result: { output: "" } })).rejects.toThrow(
      "wake failed",
    );
    expect(resume).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ProgressCallbackKey, SessionKey, type Session } from "#context/keys.js";
import { reportProgress } from "#execution/report-progress.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({ resumeHook: vi.fn() }));

function run(session: Session, callback: () => Promise<unknown>) {
  const context = new ContextContainer();
  context.set(SessionKey, session);
  return contextStorage.run(context, callback);
}

describe("reportProgress", () => {
  it("queues a report owned by the current root turn", async () => {
    await run(
      {
        auth: { current: null, initiator: null },
        sessionId: "root",
        turn: { id: "turn_1", sequence: 1 },
      },
      () => reportProgress({ callId: "call_1", message: "  Running tests\n" }),
    );

    expect(resumeHook).toHaveBeenCalledWith(
      sessionCommandHookToken("root"),
      expect.objectContaining({
        events: [
          expect.objectContaining({
            kind: "report",
            report: expect.objectContaining({ message: "Running tests" }),
            turn: expect.objectContaining({ id: "turn:root:turn_1" }),
          }),
        ],
      }),
    );
  });

  it("routes a nested local report to the root while retaining child turn ownership", async () => {
    await run(
      {
        auth: { current: null, initiator: null },
        parent: {
          callId: "child_call",
          rootSessionId: "root",
          sessionId: "parent",
          turn: { id: "parent_turn", sequence: 0 },
        },
        sessionId: "child",
        turn: { id: "child_turn", sequence: 0 },
      },
      () => reportProgress({ callId: "call_2", message: "Checking fixtures" }),
    );

    expect(resumeHook).toHaveBeenLastCalledWith(
      sessionCommandHookToken("root"),
      expect.objectContaining({
        events: [
          expect.objectContaining({
            turn: expect.objectContaining({ id: "turn:child:child_turn" }),
          }),
        ],
      }),
    );
  });

  it("posts reports from a remote child over its inherited callback", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const context = new ContextContainer();
    context.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "remote-child",
      turn: { id: "remote-turn", sequence: 0 },
    });
    context.set(ProgressCallbackKey, {
      token: "root-token",
      url: "https://root.example.com/eve/v1/callback/root-token",
      version: 1,
    });

    await contextStorage.run(context, () =>
      reportProgress({ callId: "call_3", message: "Running remote checks" }),
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://root.example.com/eve/v1/callback/root-token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects empty reports before queueing", async () => {
    await expect(
      run(
        {
          auth: { current: null, initiator: null },
          sessionId: "root",
          turn: { id: "turn", sequence: 0 },
        },
        () => reportProgress({ callId: "call", message: " \n " }),
      ),
    ).rejects.toThrow("Provide a non-empty `message`.");
  });
});

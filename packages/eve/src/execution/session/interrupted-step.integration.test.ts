import type { FilePart, UserContent } from "ai";
import { commitOf } from "#harness/session-machine/commit.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { AuthKey, SandboxKey, SessionIdKey } from "#context/keys.js";
import {
  readInterruptedAttempt,
  recoverInterruptedStep,
} from "#execution/session/interrupted-step.js";
import { TOOL_RESULT_BOUNDARY } from "#harness/messages.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { HarnessSession } from "#harness/types.js";
import { isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { withOpenTurn, withPublished } from "#internal/testing/session-machine.js";

it.each([
  { outcome: "completed" as const, isError: false },
  { outcome: "failed" as const, isError: true },
])(
  "adopts a recorded $outcome session ending without restoring providers",
  async ({ outcome, isError }) => {
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "test",
      history: [],
      sessionId: "ended-session",
    };
    const started = { type: "session.started" as const, data: {} };
    const ended = { type: "session.ended" as const, data: { outcome } };
    const recorded = withPublished(withPublished(session, [started]), [ended]);
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, session.sessionId);
    enterSessionProjection(ctx, recorded.state);
    const publish = vi.fn(async () => session);
    const at = "2026-10-21T00:00:00.000Z";
    const result = await recoverInterruptedStep({
      admission: commitOf([]),
      attempt: readInterruptedAttempt(0, [
        { position: 0, line: { at, facts: [started] } },
        { position: 1, line: { at, facts: [ended] } },
      ]),
      ctx,
      publish,
      session,
      stepInput: undefined,
    });
    expect(result).toMatchObject({ result: { action: "done", isError, output: "" } });
    expect(publish).not.toHaveBeenCalled();
  },
);

function openTurnSession(sessionId: string) {
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "test",
    history: [],
    sessionId,
  };
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  return { ctx, session: withOpenTurn(session, { sequence: 1, turnId: "turn-1" }) };
}

it("fails the turn with a fixed failure, never what a step's last attempt threw", async () => {
  const { ctx, session } = openTurnSession("exhausted-session");
  enterSessionProjection(ctx, session.state);
  const published: SessionEvent[] = [];
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, []),
    ctx,
    failed: { error: new TypeError("bad row: Alice's account number is 4242") },
    publish: async (events, current) => {
      published.push(...[events].flat());
      return current;
    },
    session,
    stepInput: undefined,
  });
  const message = "This turn failed before it finished. Send another message to continue.";
  const settled = published.find((event) => event.type === "turn.settled");
  expect(settled?.data).toMatchObject({
    error: { code: "TURN_FAILED", id: expect.any(String), message },
    outcome: "failed",
  });
  expect(JSON.stringify(published)).not.toContain("4242");
  expect(result).toMatchObject({ result: { settled: { isError: true, output: message } } });
  const errorId = (settled!.data as { readonly error: { readonly id: string } }).error.id;
  expect(JSON.stringify(logged.mock.calls)).toContain(errorId);
  expect(JSON.stringify(logged.mock.calls)).toContain("TypeError");
  expect(JSON.stringify(logged.mock.calls)).not.toContain("4242");
});

it("leaves a turn stopped while its step kept failing open for its cancel", async () => {
  const { ctx, session } = openTurnSession("stopped-session");
  enterSessionProjection(ctx, session.state);
  const published: SessionEvent[] = [];
  const stepInput = { message: "Please look up Alice's plan." };
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, []),
    ctx,
    failed: { error: new TypeError("bad row: 4242"), stopped: true },
    publish: async (events, current) => {
      published.push(...[events].flat());
      return current;
    },
    session,
    stepInput,
  });
  expect(result).toMatchObject({ stepInput });
  expect(published.filter((event) => event.type === "turn.settled")).toEqual([]);
});

it("keeps the outcome of a turn an attempt settled when every attempt failed", async () => {
  const { ctx, session } = openTurnSession("settled-session");
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, turnId: "turn-1" },
  };
  const recorded = withPublished(session, [settled]);
  enterSessionProjection(ctx, recorded.state);
  const publish = vi.fn(async () => session);
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [settled] } },
    ]),
    ctx,
    failed: { error: new Error("The session stream is unavailable") },
    publish,
    session,
    stepInput: undefined,
  });
  expect(result).toMatchObject({ result: { action: "parked", settled: { isError: false } } });
  expect(publish).not.toHaveBeenCalled();
});

it.each([
  {
    assistantParts: [
      { name: "launch_date", output: "Friday", type: "tool" as const },
      { text: "It ships Friday.", type: "text" as const },
    ],
    expectedBetween: { content: "It ships Friday.", role: "assistant" },
    label: "trailing assistant text",
    message: "Thanks, Alice here.",
    replyText: "Hi Bob.",
  },
  {
    assistantParts: [{ name: "launch_date", output: "Friday", type: "tool" as const }],
    expectedBetween: { content: TOOL_RESULT_BOUNDARY, role: "assistant" },
    label: "tool-only history needing a boundary",
    message: "Any update?",
    replyText: "Still Friday.",
  },
])(
  "recovers a settled turn's imported history with $label",
  async ({ assistantParts, expectedBetween, message, replyText }) => {
    const { ctx, session } = openTurnSession(`imported-${message}`);
    const settled = {
      type: "turn.settled" as const,
      data: { outcome: "completed" as const, reply: ["p"], turnId: "turn-1" },
    };
    enterSessionProjection(ctx, withPublished(session, [settled]).state);
    const reply = {
      type: "content.completed",
      data: { kind: "text", partId: "p", value: replyText },
    };
    const result = await recoverInterruptedStep({
      admission: commitOf([]),
      attempt: readInterruptedAttempt(0, [
        { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [reply, settled] } },
      ]),
      ctx,
      publish: vi.fn(async () => session),
      session,
      stepInput: {
        history: [
          { role: "user", text: "Bob asked about the launch." },
          { parts: assistantParts, role: "assistant" },
        ],
        message,
      },
    });
    expect("result" in result && result.result.history).toEqual([
      {
        content: "Bob asked about the launch.",
        kind: "user",
        metadata: { "eve.imported": true },
        role: "user",
      },
      {
        content: [
          { input: {}, toolCallId: "imported_0", toolName: "launch_date", type: "tool-call" },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: "Friday" },
            toolCallId: "imported_0",
            toolName: "launch_date",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      expectedBetween,
      expect.objectContaining({ content: message, role: "user" }),
      { content: replyText, role: "assistant" },
    ]);
  },
);

it("recovers a settled turn whose imported history includes user file parts with and without a sandbox", async () => {
  const bytes = Buffer.from("%PDF-1.4\nhello", "utf8");
  const fileData = `data:application/pdf;base64,${bytes.toString("base64")}`;
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, reply: ["p"], turnId: "turn-1" },
  };
  const reply = {
    type: "content.completed" as const,
    data: { kind: "text" as const, partId: "p", value: "Net 30." },
  };
  const stepInput = {
    history: [
      {
        parts: [
          { text: "Check payment terms.", type: "text" as const },
          {
            data: fileData,
            filename: "contract.pdf",
            mediaType: "application/pdf",
            type: "file" as const,
          },
        ],
        role: "user" as const,
      },
    ],
    message: "Summarize.",
  };

  const withSandbox = openTurnSession("imported-file-with-sandbox");
  const sandbox = mockSandbox({ id: "sbx_recovered_history" });
  withSandbox.ctx.set(AuthKey, null);
  withSandbox.ctx.set(SandboxKey, sandbox.access);
  enterSessionProjection(withSandbox.ctx, withPublished(withSandbox.session, [settled]).state);
  const stagedResult = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [reply, settled] } },
    ]),
    ctx: withSandbox.ctx,
    publish: vi.fn(async () => withSandbox.session),
    session: withSandbox.session,
    stepInput,
  });
  expect("result" in stagedResult).toBe(true);
  const stagedContent = (
    "result" in stagedResult ? stagedResult.result.history[0]?.content : undefined
  ) as UserContent;
  expect(stagedContent[0]).toEqual({ text: "Check payment terms.", type: "text" });
  expect(isSandboxRefUrl((stagedContent[1] as FilePart).data)).toBe(true);
  expect(sandbox.writes).toHaveLength(1);

  const withoutSandbox = openTurnSession("imported-file-no-sandbox");
  withoutSandbox.ctx.set(AuthKey, null);
  enterSessionProjection(
    withoutSandbox.ctx,
    withPublished(withoutSandbox.session, [settled]).state,
  );
  const degradedResult = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [reply, settled] } },
    ]),
    ctx: withoutSandbox.ctx,
    publish: vi.fn(async () => withoutSandbox.session),
    session: withoutSandbox.session,
    stepInput,
  });
  expect("result" in degradedResult).toBe(true);
  expect("result" in degradedResult && degradedResult.result.history[0]).toEqual({
    content: [
      { text: "Check payment terms.", type: "text" },
      {
        text: "Attachment contract.pdf could not be stored: no sandbox is available.",
        type: "text",
      },
    ],
    kind: "user",
    metadata: { "eve.imported": true },
    role: "user",
  });
});

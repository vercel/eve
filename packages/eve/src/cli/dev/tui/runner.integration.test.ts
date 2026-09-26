import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import {
  createInputRequestedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import type { AgentTUIConversationView } from "./conversation-view.js";
import { interruptedError } from "./errors.js";
import { EveTUIRunner, type AgentTUIInput, type AgentTUIRenderer } from "./runner.js";
import { FakeEveServer, reply, silent } from "./test/fake-eve-server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A renderer whose composer the test drives, recording every conversation view. */
function scriptedRenderer(overrides: Partial<AgentTUIRenderer> = {}) {
  const views: AgentTUIConversationView[] = [];
  const reads: Array<{ resolve: (input: AgentTUIInput | undefined) => void; done: boolean }> = [];
  const renderer: AgentTUIRenderer = {
    renderConversation: (view) => views.push(view),
    readInput: vi.fn(
      (options) =>
        new Promise<AgentTUIInput | undefined>((resolve, reject) => {
          const read = {
            done: false,
            resolve: (input: AgentTUIInput | undefined) => {
              read.done = true;
              if (input === undefined) reject(interruptedError());
              else resolve(input);
            },
          };
          reads.push(read);
          options?.signal?.addEventListener("abort", () => {
            read.done = true;
            resolve(undefined);
          });
        }),
    ),
    ...overrides,
  };
  const pending = () => reads.findLast((read) => !read.done);
  return {
    renderer,
    views,
    latest: () => views.at(-1)!,
    /** Waits for the composer to open, then answers it. `undefined` leaves the session. */
    async input(input: AgentTUIInput | undefined) {
      await vi.waitFor(() => expect(pending()).toBeDefined());
      pending()!.resolve(input);
    },
  };
}

function assistantText(view: AgentTUIConversationView): string[] {
  return view.conversation.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}

function startRunner(server: FakeEveServer, renderer: AgentTUIRenderer) {
  vi.stubGlobal("fetch", server.fetch);
  const run = new EveTUIRunner({
    client: new Client({ host: "http://localhost:3000" }),
    renderer,
    name: "Review Agent",
  }).run();
  return run;
}

describe("eve dev conversation", () => {
  it("renders server-initiated turns between sends from the one session stream", async () => {
    const server = new FakeEveServer(reply("Bob received the update."));
    const tui = scriptedRenderer();
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Tell Bob about the release." });
    await vi.waitFor(() =>
      expect(assistantText(tui.latest())).toContain("Bob received the update."),
    );
    await vi.waitFor(() => expect(tui.latest().working).toBe(false));

    // Alice's scheduled review wakes the agent while the composer is open.
    server.emit([
      createTurnStartedEvent({ sequence: 0, turnId: "wake" }),
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Alice finished the review.",
        sequence: 1,
        stepIndex: 0,
        turnId: "wake",
      }),
      createSessionWaitingEvent(),
    ]);
    await vi.waitFor(() =>
      expect(assistantText(tui.latest())).toEqual([
        "Bob received the update.",
        "Alice finished the review.",
      ]),
    );

    await tui.input({ type: "submit", text: "Thanks." });
    await vi.waitFor(() => expect(server.requestsTo("POST", "/session_1")).toHaveLength(1));
    await tui.input(undefined);
    await run;
    expect(server.requestsTo("GET", "/stream")).toHaveLength(1);
    expect(server.requestsTo("POST", "/session_1")[0]?.body).toMatchObject({
      turnPolicy: "queue",
    });
  });

  it("steers the running turn with a message sent while it works", async () => {
    const server = new FakeEveServer(silent());
    const tui = scriptedRenderer();
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Start the review." });
    await vi.waitFor(() => expect(server.sessionId).toBe("session_1"));
    server.emit(
      [
        createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
        createMessageAppendedEvent({
          messageDelta: "Reviewing",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ],
      "delivery_1",
    );
    await vi.waitFor(() => expect(tui.latest().working).toBe(true));

    await tui.input({ type: "submit", text: "Include Bob's note." });
    await vi.waitFor(() => expect(server.requestsTo("POST", "/session_1")).toHaveLength(1));
    expect(server.requestsTo("POST", "/session_1")[0]?.body).toMatchObject({
      message: "Include Bob's note.",
      turnPolicy: "steer",
    });
    await tui.input(undefined);
    await run;
  });

  it("answers an approval that arrives while the composer is open", async () => {
    const server = new FakeEveServer(reply("Ready."));
    const readToolApproval = vi.fn(async () => ({ approved: true }));
    const tui = scriptedRenderer({ readToolApproval });
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Hello." });
    await vi.waitFor(() => expect(tui.latest().working).toBe(false));
    server.emit([
      createTurnStartedEvent({ sequence: 0, turnId: "wake" }),
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call_1",
              input: { path: "notes.md" },
              kind: "tool-call",
              toolName: "write_file",
            },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve write_file?",
            requestId: "approval_1",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "wake",
      }),
      createSessionWaitingEvent(),
    ]);

    await vi.waitFor(() => expect(readToolApproval).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(server.requestsTo("POST", "/session_1")).toHaveLength(1));
    expect(server.requestsTo("POST", "/session_1")[0]?.body).toMatchObject({
      inputResponses: [{ requestId: "approval_1", optionId: "approve" }],
    });
    await tui.input(undefined);
    await run;
  });

  it("cancels only the turn the user watched start", async () => {
    const server = new FakeEveServer(silent());
    const tui = scriptedRenderer();
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Write a long report." });
    await vi.waitFor(() => expect(tui.latest().working).toBe(true));
    await tui.input({ type: "cancel" });
    await Promise.resolve();
    // No turn ID yet: cancellation waits instead of guessing.
    expect(server.requestsTo("POST", "/cancel")).toHaveLength(0);

    server.emit([createTurnStartedEvent({ sequence: 0, turnId: "turn_1" })], "delivery_1");
    await vi.waitFor(() => expect(server.requestsTo("POST", "/cancel")).toHaveLength(1));
    expect(server.requestsTo("POST", "/cancel")[0]?.body).toMatchObject({ turnId: "turn_1" });
    server.emit(
      [createTurnCancelledEvent({ sequence: 1, turnId: "turn_1" }), createSessionWaitingEvent()],
      "delivery_1",
    );
    await vi.waitFor(() => expect(tui.latest().working).toBe(false));
    await tui.input(undefined);
    await run;
  });

  it("starts a fresh session after the current one fails", async () => {
    const server = new FakeEveServer(silent());
    const renderSessionBoundary = vi.fn();
    const tui = scriptedRenderer({ renderSessionBoundary });
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Hello." });
    await vi.waitFor(() => expect(server.sessionId).toBe("session_1"));
    server.emit(
      [
        createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
        createSessionFailedEvent({
          code: "SANDBOX_LOST",
          message: "The sandbox stopped.",
          sessionId: "session_1",
        }),
      ],
      "delivery_1",
    );
    await vi.waitFor(() => expect(renderSessionBoundary).toHaveBeenCalledOnce());
    expect(tui.latest().conversation.messages).toEqual([]);

    await tui.input({ type: "submit", text: "Try again." });
    await vi.waitFor(() => expect(server.sessionId).toBe("session_2"));
    expect(server.requestsTo("POST", "/eve/v1/session")).toHaveLength(2);
    await tui.input(undefined);
    await run;
  });

  it("retires the session on /reset before the next message", async () => {
    const server = new FakeEveServer(reply("Done."));
    const reset = vi.fn();
    const tui = scriptedRenderer({ reset });
    const run = startRunner(server, tui.renderer);

    await tui.input({ type: "submit", text: "Hello." });
    await vi.waitFor(() => expect(tui.latest().working).toBe(false));
    await tui.input({ type: "submit", text: "/reset" });
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(server.requestsTo("POST", "/session_1/reset")).toHaveLength(1);

    await tui.input({ type: "submit", text: "Start over." });
    await vi.waitFor(() => expect(server.sessionId).toBe("session_2"));
    await tui.input(undefined);
    await run;
  });
});

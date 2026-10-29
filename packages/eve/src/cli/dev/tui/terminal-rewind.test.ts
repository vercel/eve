import { describe, expect, it } from "vitest";

import { Conversation } from "#client/conversation.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { tuiSessionData } from "./conversation-view.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { reply } from "./test/fake-eve-server.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

describe("terminal rewind", () => {
  it("repaints committed conversation on selection and never restores discarded turns", () => {
    const screen = new MockScreen({ columns: 100, rows: 40 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({ input, output: screen, color: false, unicode: true });
    const conversation = new Conversation();
    let position = 0;
    const observe = (events: readonly SessionEvent[]) => {
      for (const event of events) conversation.observe(stampTestEvent(event, position++));
      const state = conversation.state;
      renderer.renderConversation({
        conversation: state,
        data: tuiSessionData(state),
        failures: [],
        working: false,
      });
    };
    const turn = (id: string, follows: string | null, message: string, answer: string) =>
      reply(answer)({
        method: "POST",
        path: "/session",
        body: { message },
        deliveryId: `d_${id}`,
        turnId: id,
      }).map((event) =>
        event.type === "turn.started" ? { ...event, data: { ...event.data, follows } } : event,
      );
    try {
      renderer.renderAgentHeader({ name: "rewind-test", serverUrl: "http://localhost" });
      observe([
        { type: "session.started", data: {} },
        ...turn("turn_1", null, "Keep this message", "Keep this reply"),
      ]);
      observe(turn("turn_2", "turn_1", "Discard this message", "Discard this reply"));
      expect(screen.snapshot()).toContain("Keep this message");
      expect(screen.snapshot()).toContain("Discard this message");
      expect(screen.snapshot()).toContain("Discard this reply");

      renderer.renderCommandInvocation("/rewind 1");
      observe([
        { type: "context.started", data: { changeId: "c1", kind: "rewind" } },
        {
          type: "context.settled",
          data: {
            changeId: "c1",
            kind: "rewind",
            outcome: "completed",
            selects: { turnId: "turn_1" },
          },
        },
      ]);
      renderer.finishCommand({ kind: "result", summary: "Rewound" });
      expect(screen.snapshot()).toContain("Keep this message");
      expect(screen.snapshot()).toContain("Keep this reply");
      expect(screen.snapshot()).not.toContain("Discard this message");
      expect(screen.snapshot()).not.toContain("Discard this reply");
      expect(screen.snapshot()).toContain("Rewound");
      expect(screen.rawOutput()).toContain("\x1b[3J");

      renderer.setLogDisplayMode("all");
      renderer.setLogDisplayMode("none");
      expect(screen.snapshot()).not.toContain("Discard this message");
      observe(turn("turn_3", "turn_1", "Replacement message", "New reply"));
      expect(screen.snapshot()).toContain("Replacement message");
      expect(screen.snapshot()).not.toContain("Discard this reply");
      observe([
        { type: "context.started", data: { changeId: "c2", kind: "clear" } },
        {
          type: "context.settled",
          data: { changeId: "c2", kind: "clear", outcome: "completed", selects: null },
        },
      ]);
      expect(screen.snapshot()).not.toContain("Keep this message");
      expect(screen.snapshot()).not.toContain("Replacement message");
    } finally {
      renderer.shutdown();
    }
  });

  it("presents a message picker with the latest selected and supports moving to older messages", async () => {
    const screen = new MockScreen({ columns: 100, rows: 40 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({ input, output: screen, color: false, unicode: true });
    try {
      renderer.renderAgentHeader({ name: "rewind-test", serverUrl: "http://localhost" });
      const picked = renderer.chooseRewindMessage([
        { messageId: "message_1", text: "First message", hasFiles: false },
        { messageId: "message_2", text: "Second message", hasFiles: true },
      ]);
      expect(screen.snapshot()).toContain("Choose a message to edit");
      expect(screen.snapshot()).toContain("2. First message");
      expect(screen.snapshot()).toContain("1. Second message [attachment]");
      expect(screen.snapshot()).not.toContain("/1");
      input.up();
      input.enter();
      await expect(picked).resolves.toBe("message_1");
      const cancelled = renderer.chooseRewindMessage([
        { messageId: "message_1", text: "First", hasFiles: false },
      ]);
      input.ctrlC();
      await expect(cancelled).resolves.toBeUndefined();
    } finally {
      renderer.shutdown();
    }
  });
});

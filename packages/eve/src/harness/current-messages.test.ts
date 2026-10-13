import { describe, expect, it } from "vitest";

import { createCurrentMessages } from "#harness/current-messages.js";
import {
  anchorToTurn,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";

function input(content: string, turnId: string): UserModelMessage {
  return anchorToTurn({ content, kind: "user", role: "user" }, turnId);
}

function said(content: string): HarnessModelMessage {
  return { content, role: "assistant" };
}

const texts = (messages: readonly HarnessModelMessage[]) => messages.map(({ content }) => content);

describe("createCurrentMessages", () => {
  it("partitions existing history by role", () => {
    const current = createCurrentMessages([
      { role: "system", content: "system" },
      { role: "user", content: "user", kind: "user" },
    ]);
    const directMutationIsRejected = () => {
      // @ts-expect-error current-message placement must go through add/addSystem.
      current.systemMessages.push({ role: "system", content: "bypass" });
    };

    expect(current.systemMessages).toEqual([{ role: "system", content: "system" }]);
    expect(current.nonSystemMessages).toEqual([{ role: "user", content: "user", kind: "user" }]);
    expect(directMutationIsRejected).toBeTypeOf("function");
  });

  it("returns snapshots instead of exposing its backing arrays", () => {
    const current = createCurrentMessages([{ role: "system", content: "system" }]);
    const exposed = current.systemMessages as Array<{ role: "system"; content: string }>;

    exposed.push({ role: "system", content: "bypass" });

    expect(current.systemMessages).toEqual([{ role: "system", content: "system" }]);
  });

  it("persists framework context as user messages from the first turn", () => {
    const current = createCurrentMessages([]);

    current.add("first", "context.instruction");
    current.add("later", "context.instruction");

    expect(current.systemMessages).toEqual([]);
    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "first", kind: "context.instruction" },
      { role: "user", content: "later", kind: "context.instruction" },
    ]);
    expect(current.history).toEqual(current.nonSystemMessages);
  });

  it("inserts later context before the current turn input", () => {
    const currentTurnMessages = [
      { role: "user" as const, content: "channel context", kind: "user" as const },
      { role: "user" as const, content: "current request", kind: "user" as const },
    ];
    const current = createCurrentMessages(
      [{ role: "user", content: "history", kind: "user" }, ...currentTurnMessages],
      { currentTurnMessages },
    );

    current.add("skills state", "context.state");
    current.add("channel guidance", "context.instruction");

    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "history", kind: "user" },
      { role: "user", content: "skills state", kind: "context.state" },
      { role: "user", content: "channel guidance", kind: "context.instruction" },
      { role: "user", content: "channel context", kind: "user" },
      { role: "user", content: "current request", kind: "user" },
    ]);
  });

  it("appends messages without interpreting their text", () => {
    const current = createCurrentMessages([
      { role: "user", content: "[Skills]\nuser-authored text", kind: "user" },
    ]);

    current.add("[Skills]\nworking", "context.state");
    current.add("[Skills]\nworking", "context.state");

    expect(current.history.map((message) => message.content)).toEqual([
      "[Skills]\nuser-authored text",
      "[Skills]\nworking",
      "[Skills]\nworking",
    ]);
  });

  it("persists additions without storing client context or replacing projected history", () => {
    const hidden = {
      role: "user" as const,
      content: "hidden by projection",
      kind: "user" as const,
    };
    const input = { role: "user" as const, content: "request", kind: "user" as const };
    const current = createCurrentMessages([hidden, input], {
      currentTurnMessages: [input],
      projectedMessages: [
        { role: "user", content: "ephemeral client context", kind: "user" },
        input,
      ],
    });
    current.add("[Skills]\nworking", "context.state");
    current.addSystem({ role: "system", content: "turn-scoped instructions" });
    expect(current.history).toEqual([
      hidden,
      { role: "user", content: "[Skills]\nworking", kind: "context.state" },
      input,
    ]);
    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "ephemeral client context", kind: "user" },
      { role: "user", content: "[Skills]\nworking", kind: "context.state" },
      input,
    ]);
  });

  it("keeps hierarchy-sensitive context in instructions when requested", () => {
    const current = createCurrentMessages([]);

    current.add("authoritative", "context.instruction", { cacheFriendly: false });

    expect(current.systemMessages).toEqual([{ role: "system", content: "authoritative" }]);
    expect(current.nonSystemMessages).toEqual([]);
  });

  it("adds prebuilt system messages only through the system API", () => {
    const current = createCurrentMessages([]);

    current.addSystem([
      { role: "system", content: "one" },
      { role: "system", content: "two" },
    ]);

    expect(current.systemMessages).toEqual([
      { role: "system", content: "one" },
      { role: "system", content: "two" },
    ]);
    expect(current.nonSystemMessages).toEqual([]);
  });

  describe("anchored context", () => {
    /** One model call's messages, the way requestMessages builds them. */
    function call(
      history: readonly HarnessModelMessage[],
      turn: readonly UserModelMessage[],
      recalled: readonly { readonly turnId: string; readonly content: string }[],
      announce?: string,
    ) {
      const current = createCurrentMessages(history, { currentTurnMessages: turn });
      if (announce !== undefined) current.add(announce, "context.state");
      current.addAnchored(recalled, "memory.load");
      return current;
    }

    it("keeps each turn's context ahead of its input, so each call extends the one before", () => {
      const first = input("first request", "turn_0");
      const recalledFirst = [{ content: "memory A", turnId: "turn_0" }];
      const opening = call([first], [first], recalledFirst);
      const continuing = call([first, said("working")], [first], recalledFirst);
      const second = input("second request", "turn_1");
      const later = [first, said("working"), said("done"), second];
      const recalled = [...recalledFirst, { content: "memory B", turnId: "turn_1" }];
      const next = call(later, [second], recalled, "skills state");
      const after = call([...next.history, said("on it")], [second], recalled);

      expect(texts(opening.nonSystemMessages)).toEqual(["memory A", "first request"]);
      expect(texts(next.nonSystemMessages)).toEqual([
        "memory A",
        "first request",
        "working",
        "done",
        "skills state",
        "memory B",
        "second request",
      ]);
      for (const [before, then] of [
        [opening, continuing],
        [continuing, next],
        [next, after],
      ] as const) {
        expect(then.nonSystemMessages.slice(0, before.nonSystemMessages.length)).toEqual(
          before.nonSystemMessages,
        );
      }
      expect(texts(next.history)).not.toContain("memory B");
    });

    it("puts context whose turn compaction summarized after the checkpoint", () => {
      const latest = input("latest request", "turn_5");
      const compacted: HarnessModelMessage[] = [
        { content: "checkpoint", kind: "context.compaction", role: "user" },
        said("summary"),
        latest,
      ];

      const current = call(
        compacted,
        [latest],
        [
          { content: "memory A", turnId: "turn_0" },
          { content: "memory C", turnId: "turn_5" },
        ],
      );

      expect(texts(current.nonSystemMessages)).toEqual([
        "checkpoint",
        "summary",
        "memory A",
        "memory C",
        "latest request",
      ]);
    });
  });
});

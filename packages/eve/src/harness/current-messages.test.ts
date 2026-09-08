import { describe, expect, it } from "vitest";

import { createCurrentMessages } from "#harness/current-messages.js";

describe("createCurrentMessages", () => {
  it("partitions existing history by role", () => {
    const current = createCurrentMessages([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
    const directMutationIsRejected = () => {
      // @ts-expect-error current-message placement must go through add/addSystem.
      current.systemMessages.push({ role: "system", content: "bypass" });
    };

    expect(current.systemMessages).toEqual([{ role: "system", content: "system" }]);
    expect(current.nonSystemMessages).toEqual([{ role: "user", content: "user" }]);
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

    current.add("first");
    current.add("later");

    expect(current.systemMessages).toEqual([]);
    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "later" },
    ]);
    expect(current.history).toEqual(current.nonSystemMessages);
  });

  it("inserts later context before the current turn input", () => {
    const currentTurnMessages = [
      { role: "user" as const, content: "channel context" },
      { role: "user" as const, content: "current request" },
    ];
    const current = createCurrentMessages(
      [{ role: "user", content: "history" }, ...currentTurnMessages],
      { currentTurnMessages },
    );

    current.add("task state");
    current.add("delivery guidance");

    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "history" },
      { role: "user", content: "task state" },
      { role: "user", content: "delivery guidance" },
      { role: "user", content: "channel context" },
      { role: "user", content: "current request" },
    ]);
  });

  it("appends messages without interpreting their text", () => {
    const current = createCurrentMessages([
      { role: "user", content: "[Task state]\nuser-authored text" },
    ]);

    current.add("[Task state]\nworking");
    current.add("[Task state]\nworking");

    expect(current.history.map((message) => message.content)).toEqual([
      "[Task state]\nuser-authored text",
      "[Task state]\nworking",
      "[Task state]\nworking",
    ]);
  });

  it("persists additions without storing client context or replacing projected history", () => {
    const hidden = { role: "user" as const, content: "hidden by projection" };
    const input = { role: "user" as const, content: "request" };
    const current = createCurrentMessages([hidden, input], {
      currentTurnMessages: [input],
      projectedMessages: [{ role: "user", content: "ephemeral client context" }, input],
    });
    current.add("[Task state]\nworking");
    current.addSystem({ role: "system", content: "turn-scoped instructions" });
    expect(current.history).toEqual([
      hidden,
      { role: "user", content: "[Task state]\nworking" },
      input,
    ]);
    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "ephemeral client context" },
      { role: "user", content: "[Task state]\nworking" },
      input,
    ]);
  });

  it("keeps later context out of the tail when history ends with an approval response", () => {
    const approvalTail = {
      role: "tool" as const,
      content: [
        {
          approvalId: "approval-1",
          approved: true,
          type: "tool-approval-response" as const,
        },
      ],
    };
    const current = createCurrentMessages([
      { role: "user", content: "history" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: {} },
          { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
        ],
      },
      approvalTail,
    ]);

    current.add("task state");

    expect(current.systemMessages).toEqual([{ role: "system", content: "task state" }]);
    expect(current.nonSystemMessages.at(-1)).toBe(approvalTail);
  });

  it("keeps hierarchy-sensitive context in instructions when requested", () => {
    const current = createCurrentMessages([]);

    current.add("authoritative", { cacheFriendly: false });

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
});

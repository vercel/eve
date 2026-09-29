import { describe, expect, it } from "vitest";

import { createCurrentMessages } from "#harness/current-messages.js";

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

  it("prepares tracked announcements without advancing the recorded baseline", () => {
    const recorded = { availableSkills: "working" };
    const current = createCurrentMessages([{ role: "user", content: "working", kind: "user" }], {
      historyState: recorded,
    });

    current.addAnnouncements({ availableSkills: "working" });
    current.addAnnouncements({ availableSkills: "completed" });
    current.addAnnouncements({ availableSkills: "completed" });

    expect(recorded).toEqual({ availableSkills: "working" });
    expect(current.historyState).toEqual({ availableSkills: "completed" });
    expect(current.history).toEqual([
      { role: "user", content: "working", kind: "user" },
      { role: "user", content: "completed", kind: "context.state" },
    ]);
  });

  it("ignores empty or absent announcements", () => {
    const current = createCurrentMessages([]);
    current.addAnnouncements({ availableSkills: "skills" });
    current.addAnnouncements({ availableSkills: "" });
    current.addAnnouncements({});

    expect(current.history).toEqual([{ role: "user", content: "skills", kind: "context.state" }]);
    expect(current.historyState).toEqual({ availableSkills: "skills" });
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
      { role: "user", content: "history", kind: "user" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: {} },
          { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
        ],
      },
      approvalTail,
    ]);

    current.addAnnouncements({ availableSkills: "skills" });

    expect(current.systemMessages).toEqual([{ role: "system", content: "skills" }]);
    expect(current.nonSystemMessages.at(-1)).toBe(approvalTail);
    expect(current.historyState).toEqual({});
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
});

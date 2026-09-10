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

    current.add("task state", "context.state");
    current.add("delivery guidance", "context.instruction");

    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "history", kind: "user" },
      { role: "user", content: "task state", kind: "context.state" },
      { role: "user", content: "delivery guidance", kind: "context.instruction" },
      { role: "user", content: "channel context", kind: "user" },
      { role: "user", content: "current request", kind: "user" },
    ]);
  });

  it("appends messages without interpreting their text", () => {
    const current = createCurrentMessages([
      { role: "user", content: "[Task state]\nuser-authored text", kind: "user" },
    ]);

    current.add("[Task state]\nworking", "context.state");
    current.add("[Task state]\nworking", "context.state");

    expect(current.history.map((message) => message.content)).toEqual([
      "[Task state]\nuser-authored text",
      "[Task state]\nworking",
      "[Task state]\nworking",
    ]);
  });

  it("prepares tracked announcements without advancing the recorded baseline", () => {
    const recorded = { taskState: "working" };
    const current = createCurrentMessages([{ role: "user", content: "working", kind: "user" }], {
      historyState: recorded,
    });

    current.addAnnouncements({ taskState: "working" });
    current.addAnnouncements({ taskState: "completed" });
    current.addAnnouncements({ taskState: "completed", availableSkills: "completed" });

    expect(recorded).toEqual({ taskState: "working" });
    expect(current.historyState).toEqual({ taskState: "completed", availableSkills: "completed" });
    expect(current.history).toEqual([
      { role: "user", content: "working", kind: "user" },
      { role: "user", content: "completed", kind: "context.state" },
      { role: "user", content: "completed", kind: "context.state" },
    ]);
  });

  it("keeps announcement order stable and ignores empty or absent values", () => {
    const current = createCurrentMessages([]);
    current.addAnnouncements({
      deliveryInstruction: "report",
      taskState: "working",
      availableSkills: "skills",
    });
    current.addAnnouncements({ availableSkills: "", taskState: undefined });

    expect(current.history).toEqual([
      { role: "user", content: "skills", kind: "context.state" },
      { role: "user", content: "working", kind: "context.state" },
      { role: "user", content: "report", kind: "context.instruction" },
    ]);
    expect(current.historyState).toEqual({
      availableSkills: "skills",
      taskState: "working",
      deliveryInstruction: "report",
    });
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
    current.add("[Task state]\nworking", "context.state");
    current.addSystem({ role: "system", content: "turn-scoped instructions" });
    expect(current.history).toEqual([
      hidden,
      { role: "user", content: "[Task state]\nworking", kind: "context.state" },
      input,
    ]);
    expect(current.nonSystemMessages).toEqual([
      { role: "user", content: "ephemeral client context", kind: "user" },
      { role: "user", content: "[Task state]\nworking", kind: "context.state" },
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

    current.addAnnouncements({ taskState: "task state" });

    expect(current.systemMessages).toEqual([{ role: "system", content: "task state" }]);
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

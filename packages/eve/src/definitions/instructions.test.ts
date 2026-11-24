import { describe, expect, it } from "vitest";

import {
  announcedNext,
  beforeModelCall,
  evaluationError,
  definitionSession,
} from "#internal/testing/definition-session.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { stepSystem } from "#definitions/step.js";
import { restoreDefinitions } from "#definitions/kernel.js";
import { DefinitionsStateKey, readSlot } from "#definitions/state.js";
import { contextStorage } from "#context/container.js";
import { HistoryStateKey } from "#context/keys.js";
import { keptAnnouncements } from "#harness/announcements.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const system = async (ctx: ReturnType<typeof definitionSession>["ctx"]) => {
  const prompt = await stepSystem({
    config: { tools: new Map() },
    ctx,
    finalReplyOnly: false,
    session: {},
  });
  return typeof prompt === "string" ? [] : prompt.slice(1);
};

describe("dynamic instructions", () => {
  it("keeps system instructions in definition order, and drops one that returns null or blank text", async () => {
    let policy: string | null = "Follow the policy.";
    const { ctx } = definitionSession({
      instructions: [
        { evaluate: () => defineInstructions({ content: "Be brief." }), slug: "brief" },
        {
          evaluate: () => (policy === null ? null : defineInstructions({ content: policy })),
          slug: "policy",
        },
        { evaluate: () => defineInstructions({ content: "   " }), slug: "blank" },
      ],
    });
    await beforeModelCall(ctx);
    expect(await system(ctx)).toEqual(["Be brief.", "Follow the policy."]);

    policy = null;
    await beforeModelCall(ctx);
    expect(await system(ctx)).toEqual(["Be brief."]);
  });

  it("keeps user instructions out of the system prompt and adds no message for blank text", async () => {
    const { ctx } = definitionSession({
      instructions: [
        {
          evaluate: () => defineInstructions({ content: "Alice prefers tables.", role: "user" }),
          slug: "prefs",
        },
        { evaluate: () => defineInstructions({ content: "\n", role: "user" }), slug: "blank" },
      ],
    });
    expect(await announcedNext(ctx)).toEqual(["Alice prefers tables."]);
    expect(await system(ctx)).toEqual([]);
  });

  it("announces static user instructions once, as it does dynamic ones", async () => {
    const { ctx } = definitionSession({ userInstructions: ["  Pinned policy.  ", " \n "] });
    expect(await announcedNext(ctx)).toEqual(["Pinned policy."]);
    expect(await announcedNext(ctx)).toEqual([]);
  });

  it("doesn't announce a static user instruction a session from before holds in its history", async () => {
    const { ctx } = definitionSession({ userInstructions: ["Pinned policy."] });
    const conversation = [createFrameworkUserMessage("context.instruction", "Pinned policy.")];
    await contextStorage.run(ctx, () => restoreDefinitions(ctx, { conversation }));
    expect(await announcedNext(ctx)).toEqual([]);
  });

  it("rejects a value without defineInstructions()", async () => {
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => ({ content: "Be brief." }), slug: "brief" }],
    });
    expect(await evaluationError(ctx)).toBe(
      'The dynamic instructions "brief" returned an unbranded value — wrap with defineInstructions().',
    );
  });

  it("handles single -> map -> single transitions while preserving legacy single-entry slot compatibility", async () => {
    let current:
      | ReturnType<typeof defineInstructions>
      | Record<string, ReturnType<typeof defineInstructions>> = defineInstructions({
      content: "Single note",
      role: "user",
    });
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => current, slug: "notes" }],
    });

    expect(await announcedNext(ctx)).toEqual(["Single note"]);
    expect(readSlot(ctx, "instructions:notes")?.value).toEqual({
      content: "Single note",
      role: "user",
    });

    current = { a: defineInstructions({ content: "Map A", role: "user" }) };
    expect(await announcedNext(ctx)).toEqual(["Map A"]);

    current = defineInstructions({ content: "Single note", role: "user" });
    expect(await announcedNext(ctx)).toEqual(["Single note"]);

    current = { a: defineInstructions({ content: "Map A", role: "user" }) };
    expect(await announcedNext(ctx)).toEqual(["Map A"]);
  });

  it("keeps map keys containing colons distinct across slugs and keys", async () => {
    let includeRepoKey = true;
    const { ctx } = definitionSession({
      instructions: [
        {
          evaluate: () =>
            includeRepoKey
              ? {
                  "a:b": defineInstructions({ content: "From repo a:b", role: "user" }),
                  "repo:/workspace/a:b": defineInstructions({
                    content: "From workspace path",
                    role: "user",
                  }),
                }
              : {
                  "repo:/workspace/a:b": defineInstructions({
                    content: "From workspace path",
                    role: "user",
                  }),
                },
          slug: "repo",
        },
        {
          evaluate: () => ({
            b: defineInstructions({ content: "From repo:a b", role: "user" }),
          }),
          slug: "repo:a",
        },
      ],
    });

    expect(await announcedNext(ctx)).toEqual([
      "From repo a:b",
      "From workspace path",
      "From repo:a b",
    ]);

    includeRepoKey = false;
    expect(await announcedNext(ctx)).toEqual([]);

    includeRepoKey = true;
    expect(await announcedNext(ctx)).toEqual(["From repo a:b"]);
  });

  it("produces identical slot digests across repeated evaluations with the same memos", async () => {
    let entries: Record<string, ReturnType<typeof defineInstructions>> = {
      a: defineInstructions({ content: "Alpha", role: "user" }),
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => entries, slug: "stable" }],
    });

    expect(await announcedNext(ctx)).toEqual(["Alpha", "Beta"]);
    entries = { b: defineInstructions({ content: "Beta", role: "user" }) };

    const { records } = captureLogRecords();
    const previousEveDev = process.env.EVE_DEV;
    process.env.EVE_DEV = "1";
    try {
      await beforeModelCall(ctx);
      const first = readSlot(ctx, "instructions:stable");
      await beforeModelCall(ctx);
      const second = readSlot(ctx, "instructions:stable");
      expect(second?.digest).toBe(first?.digest);
      expect(second?.value).toEqual(first?.value);
      expect(records.filter((record) => record.level === "warn")).toEqual([]);
    } finally {
      if (previousEveDev === undefined) delete process.env.EVE_DEV;
      else process.env.EVE_DEV = previousEveDev;
    }
  });

  it("tracks keyed user instructions independently across adds, updates, removals, and restarts", async () => {
    let entries: Record<string, ReturnType<typeof defineInstructions>> | null = {
      a: defineInstructions({ content: "Alpha", role: "user" }),
    };
    const resolver = { evaluate: () => entries, slug: "repos" };
    const { ctx } = definitionSession({ instructions: [resolver] });

    expect(await announcedNext(ctx)).toEqual(["Alpha"]);

    entries = {
      a: defineInstructions({ content: "Alpha", role: "user" }),
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    expect(await announcedNext(ctx)).toEqual(["Beta"]);

    entries = {
      a: defineInstructions({ content: "Alpha v2", role: "user" }),
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    expect(await announcedNext(ctx)).toEqual(["Alpha v2"]);

    entries = {
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    expect(await announcedNext(ctx)).toEqual([]);

    const { ctx: restored } = definitionSession({ instructions: [resolver] });
    restored.set(DefinitionsStateKey, ctx.get(DefinitionsStateKey)!);
    restored.set(HistoryStateKey, ctx.get(HistoryStateKey)!);
    await contextStorage.run(restored, () => restoreDefinitions(restored));

    entries = {
      a: defineInstructions({ content: "Alpha v2", role: "user" }),
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    expect(await announcedNext(restored)).toEqual(["Alpha v2"]);

    entries = null;
    expect(await announcedNext(restored)).toEqual([]);

    entries = {
      b: defineInstructions({ content: "Beta", role: "user" }),
    };
    expect(await announcedNext(restored)).toEqual(["Beta"]);
  });

  it("re-announces only keys dropped from history after compaction", async () => {
    const { ctx } = definitionSession({
      instructions: [
        {
          evaluate: () => ({
            a: defineInstructions({ content: "Alpha", role: "user" }),
            b: defineInstructions({ content: "Beta", role: "user" }),
          }),
          slug: "repos",
        },
      ],
    });
    expect(await announcedNext(ctx)).toEqual(["Alpha", "Beta"]);

    const kept = keptAnnouncements(ctx.get(HistoryStateKey) ?? {}, [
      createFrameworkUserMessage("context.instruction", "Beta"),
    ]);
    ctx.set(HistoryStateKey, kept);

    expect(await announcedNext(ctx)).toEqual(["Alpha"]);
  });

  it("keeps keyed system instructions in key order, separates mixed roles, and ignores blank entries", async () => {
    let role: "user" | "system" = "user";
    const { ctx } = definitionSession({
      instructions: [
        {
          evaluate: () => ({
            first: defineInstructions({ content: "First." }),
            blankSystem: defineInstructions({ content: "   " }),
            note: defineInstructions({ content: "Note.", role }),
            second: defineInstructions({ content: "Second." }),
            blankUser: defineInstructions({ content: "\n", role: "user" }),
          }),
          slug: "mixed",
        },
      ],
    });

    expect(await announcedNext(ctx)).toEqual(["Note."]);
    expect(await system(ctx)).toEqual(["First.", "Second."]);

    role = "system";
    expect(await announcedNext(ctx)).toEqual([]);
    expect(await system(ctx)).toEqual(["First.", "Note.", "Second."]);

    role = "user";
    expect(await announcedNext(ctx)).toEqual(["Note."]);
    expect(await system(ctx)).toEqual(["First.", "Second."]);
  });

  it.each([
    ["a primitive", "plain string", "must return defineInstructions()"],
    ["an array", [defineInstructions({ content: "A" })], "must return defineInstructions()"],
    ["a non-plain object", new Map(), "must return defineInstructions()"],
    [
      "an unbranded map entry",
      { ok: defineInstructions({ content: "A" }), bad: { content: "B" } },
      "wrap with defineInstructions()",
    ],
    ["an empty map key", { "": defineInstructions({ content: "A" }) }, "invalid instruction key"],
    ["a blank map key", { "   ": defineInstructions({ content: "A" }) }, "invalid instruction key"],
    [
      "a NUL map key",
      { "bad\0key": defineInstructions({ content: "A" }) },
      "invalid instruction key",
    ],
    [
      "a control-character map key",
      { "bad\nkey": defineInstructions({ content: "A" }) },
      "invalid instruction key",
    ],
  ])("rejects %s", async (_label, value, expected) => {
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => value, slug: "invalid" }],
    });
    expect(await evaluationError(ctx)).toContain(expected);
  });
});

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
import { contextStorage } from "#context/container.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { readDefinitionsState, writeDefinitionsState } from "#definitions/state.js";

/** The system prompt's parts after its first: the dynamic system instructions. */
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

  it.each([false, true])(
    "migrates a legacy dynamic digest only if its instruction remains in history (retained: %s)",
    async (retained) => {
      const content = "Alice prefers tables.";
      const { ctx } = definitionSession({
        instructions: [
          {
            evaluate: () => defineInstructions({ content, role: "user" }),
            slug: "prefs",
          },
        ],
      });
      await beforeModelCall(ctx);
      const state = readDefinitionsState(ctx);
      const id = "instructions:prefs";
      writeDefinitionsState(ctx, { ...state, appended: { [id]: state.slots[id]!.digest } });
      const conversation = retained
        ? [createFrameworkUserMessage("context.instruction", content)]
        : [];

      await contextStorage.run(ctx, () => restoreDefinitions(ctx, { conversation }));

      expect(await announcedNext(ctx)).toEqual(retained ? [] : [content]);
    },
  );

  it("rejects a value without defineInstructions()", async () => {
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => ({ content: "Be brief." }), slug: "brief" }],
    });
    expect(await evaluationError(ctx)).toContain("wrap with defineInstructions()");
  });
});

import { describe, expect, it } from "vitest";

import {
  beforeModelCall,
  evaluationError,
  definitionSession,
} from "#internal/testing/definition-session.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { stepSystem } from "#definitions/step.js";
import { takeUserInstructionMessages } from "./instructions.js";

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
    await beforeModelCall(ctx);

    expect(await system(ctx)).toEqual([]);
    expect(takeUserInstructionMessages(ctx).map(({ content }) => content)).toEqual([
      "Alice prefers tables.",
    ]);
  });

  it("rejects a value without defineInstructions()", async () => {
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => ({ content: "Be brief." }), slug: "brief" }],
    });
    expect(await evaluationError(ctx)).toContain("wrap with defineInstructions()");
  });
});

import { describe, expect, it } from "vitest";

import {
  beforeModelCall,
  evaluationError,
  reactionSession,
} from "#internal/testing/reaction-session.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { dynamicInstructionMessages, takeUserInstructionMessages } from "./instructions.js";

const system = (ctx: ReturnType<typeof reactionSession>["ctx"]) =>
  dynamicInstructionMessages(ctx).map(({ content }) => content);

describe("dynamic instructions", () => {
  it("keeps system instructions in definition order, and drops one that returns null or blank text", async () => {
    let policy: string | null = "Follow the policy.";
    const { ctx } = reactionSession({
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
    expect(system(ctx)).toEqual(["Be brief.", "Follow the policy."]);

    policy = null;
    await beforeModelCall(ctx);
    expect(system(ctx)).toEqual(["Be brief."]);
  });

  it("keeps user instructions out of the system prompt and adds no message for blank text", async () => {
    const { ctx } = reactionSession({
      instructions: [
        {
          evaluate: () => defineInstructions({ content: "Alice prefers tables.", role: "user" }),
          slug: "prefs",
        },
        { evaluate: () => defineInstructions({ content: "\n", role: "user" }), slug: "blank" },
      ],
    });
    await beforeModelCall(ctx);

    expect(system(ctx)).toEqual([]);
    expect(takeUserInstructionMessages(ctx).map(({ content }) => content)).toEqual([
      "Alice prefers tables.",
    ]);
  });

  it("rejects a value without defineInstructions()", async () => {
    const { ctx } = reactionSession({
      instructions: [{ evaluate: () => ({ content: "Be brief." }), slug: "brief" }],
    });
    expect(await evaluationError(ctx)).toContain("wrap with defineInstructions()");
  });
});

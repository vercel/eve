import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { defineContext } from "#embed/agent.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createSession } from "#embed/session.js";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

// Deploys once it sees its instructions, its skill, and the branch; then says how it went.
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const result = prompt
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((part) => part.type === "tool-result");
      if (result?.type === "tool-result") return textStreamResult(`Deploy: ${result.output.type}.`);
      const text = JSON.stringify(prompt);
      const missing = ["careful release manager", "release-notes", "branch: feature/x"].filter(
        (needle) => !text.includes(needle),
      );
      return missing.length === 0
        ? toolCallsStreamResult([
            { input: '{"env":"prod"}', toolCallId: "call-deploy", toolName: "deploy" },
          ])
        : textStreamResult(`Missing: ${missing.join(", ")}.`);
    },
    modelId: "embed-scripted",
    provider: "eve-test",
  }),
);

/** The release agent, whose `deploy` asks first and records each run and who ran it. */
function releaseAgent(deployed: unknown[], callers: (string | undefined)[]) {
  return defineAgent({
    definitions: [defineContext("branch", () => "branch: feature/x")],
    instructions: "You are a careful release manager.",
    model,
    modelContextWindowTokens: 200_000,
    name: "release",
    skills: {
      "release-notes": { content: "Write notes per change.", description: "Release notes." },
    },
    tools: {
      deploy: defineTool({
        approval: always(),
        description: "Deploy the current branch.",
        execute: async (input: Record<string, unknown>, ctx) => {
          deployed.push(input);
          callers.push(ctx.session.auth.current?.principalId);
          return { ok: true };
        },
        inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      }),
    },
  });
}

describe("an agent defined in code, in this process", () => {
  it("asks before a tool that needs approval, then runs it as the session's identity", async () => {
    const deployed: unknown[] = [];
    const callers: (string | undefined)[] = [];
    const session = await createSession(releaseAgent(deployed, callers), { identity: alice });
    try {
      const asked = await (await session.send("Ship it.")).result();
      expect(asked.reply).toBeUndefined();
      expect(asked.interactions.map((interaction) => interaction.call?.name)).toEqual(["deploy"]);
      expect(deployed).toEqual([]);

      const delivery = await session.respond([
        { interactionId: asked.interactions[0]!.interactionId, optionId: "approve" },
      ]);
      const types: string[] = [];
      for await (const event of delivery.stream()) types.push(event.type);
      const answered = await delivery.result();

      expect(answered.reply).toBe("Deploy: json.");
      expect(answered.sessionId).toBe(session.id);
      expect(deployed).toEqual([{ env: "prod" }]);
      expect(callers).toEqual(["alice"]);
      expect(types).toContain("call.settled");
      expect(types).toContain("turn.settled");
    } finally {
      await session.close();
    }
  });

  it("resumes a session its World kept while it waited on an approval, which then runs once approved", async () => {
    const deployed: unknown[] = [];
    const callers: (string | undefined)[] = [];
    const release = releaseAgent(deployed, callers);
    const world = memoryWorld();
    const first = await createSession(release, { identity: alice, world });
    const asked = await (await first.send("Ship it.")).result();
    expect(asked.interactions.map((interaction) => interaction.call?.name)).toEqual(["deploy"]);
    // A snapshot taken now holds what the World holds.
    expect((await first.checkpoint()).open).toMatchObject({ at: "pause" });
    // Suspended, not closed: closing would end the session.
    await first.suspend();

    const saved = await createWorldSessionStore(world).load(asked.sessionId);
    expect(saved?.open).toMatchObject({ at: "pause", pause: { on: "interaction" } });
    const second = await createSession(release, {
      identity: alice,
      resume: asked.sessionId,
      world,
    });
    try {
      expect(second.id).toBe(asked.sessionId);
      const pending = await second.pending();
      expect(pending.map((interaction) => interaction.call?.name)).toEqual(["deploy"]);
      const answered = await (
        await second.respond([{ interactionId: pending[0]!.interactionId, optionId: "approve" }])
      ).result();
      expect(answered.reply).toBe("Deploy: json.");
      expect(answered.sessionId).toBe(asked.sessionId);
      expect(deployed).toEqual([{ env: "prod" }]);
      expect(callers).toEqual(["alice"]);
      await expect(second.pending()).resolves.toEqual([]);
    } finally {
      await second.close();
    }
  });
});

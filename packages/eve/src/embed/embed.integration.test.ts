import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { codeAgent, defineContext } from "#embed/agent.js";
import { createSession } from "#embed/session.js";
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

describe("an agent defined in code, in this process", () => {
  it("asks before a tool that needs approval, then runs it as the session's identity", async () => {
    const deployed: unknown[] = [];
    const callers: (string | undefined)[] = [];
    const release = codeAgent({
      definitions: [defineContext("branch", () => "branch: feature/x")],
      instructions: "You are a careful release manager.",
      model: { model, modelContextWindowTokens: 200_000 },
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
    const session = createSession(release, { identity: alice });
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
});

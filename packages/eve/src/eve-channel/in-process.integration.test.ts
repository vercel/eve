import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { codeAgentOf } from "#embed/agent.js";
import { Client } from "#client/index.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { createInProcessChannelFetch } from "#eve-channel/in-process.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";

// `eve/client` driving an agent defined in code with no HTTP server: the client's `fetch` serves
// the eve channel's own routes in this process, over the in-process runtime.

const caller = {
  attributes: {},
  authenticator: "embedded",
  issuer: "local",
  principalId: "alice",
  principalType: "user",
} as const;

describe("the eve channel served in-process", () => {
  it("creates a session, asks for approval, and streams the turn to eve/client", async () => {
    const ran: unknown[] = [];
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          if (prompt.at(-1)?.role === "tool") return textStreamResult("Deployed.");
          if (JSON.stringify(prompt.at(-1)).includes("Ship it"))
            return toolCallsStreamResult([
              { input: '{"env":"prod"}', toolCallId: "call-1", toolName: "deploy" },
            ]);
          return textStreamResult("Hello from in-process.");
        },
        modelId: "in-process-scripted",
        provider: "eve-test",
      }),
    );
    const release = defineAgent({
      model,
      modelContextWindowTokens: 200_000,
      name: "release",
      tools: {
        deploy: defineTool({
          approval: always(),
          description: "Deploy.",
          execute: async (input: Record<string, unknown>, ctx) => {
            ran.push({ input, who: ctx.session.auth.current?.principalId });
            return { ok: true };
          },
          inputSchema: { properties: { env: { type: "string" } }, type: "object" },
        }),
      },
    });
    const unhold = holdSessionAgent(codeAgentOf(release));
    const runtime = createInProcessRuntime({ agent: codeAgentOf(release) });
    const client = new Client({
      baseUrl: "http://in-process.invalid",
      fetch: createInProcessChannelFetch({ agentName: "release", caller, runtime }),
    });
    try {
      expect((await client.health()).ok).toBe(true);
      expect((await client.fetch("/eve/v1/nowhere")).status).toBe(404);

      const { delivery, session } = await client.sessions.create({ message: "Ship it." });
      const first = await delivery.result();
      expect(first.status).toBe("awaiting-input");
      const approval = first.interactions.find((i) => i.status === "open")!;
      expect(approval.call?.name).toBe("deploy");

      const answered = await session.respond([
        { interactionId: approval.interactionId, optionId: "approve" },
      ]);
      const second = await answered.result();
      expect(second).toMatchObject({ reply: "Deployed.", status: "completed" });
      expect(ran).toEqual([{ input: { env: "prod" }, who: "alice" }]);

      const third = await (await session.send("Hi.")).result();
      expect(third).toMatchObject({ reply: "Hello from in-process.", status: "completed" });

      // The stream a client reads back is the session's whole history.
      const types: string[] = [];
      for await (const event of session.stream({ follow: false, startIndex: 0 }))
        types.push(event.type);
      expect(types[0]).toBe("session.started");
      expect(types.filter((type) => type === "turn.settled")).toHaveLength(2);
      expect(types).toContain("interaction.opened");
    } finally {
      await runtime.dispose();
      unhold();
    }
  });
});

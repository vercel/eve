import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";
import { defineDynamic } from "#dynamic/definition.js";
import { localWorld } from "#execution/world/local-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { worldScheduleProvider } from "#public/schedules/providers/world.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";
import { createWorldHost, type WorldHost } from "./host.js";

// Dynamic schedules on a World host: a session creates one with `worldScheduleProvider()`, the
// World keeps it, and the host's tick runs its occurrence once, in a session of its own that the
// schedule's collection starts through a channel.

const alice = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};

let dir: string;
let host: WorldHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-world-host-schedules-"));
});
afterEach(async () => {
  await host?.close();
  await host?.world.close?.();
  host = undefined;
  rmSync(dir, { force: true, recursive: true });
});

async function eventsUntil(
  events: ReadableStream<SessionStreamEvent>,
  done: (seen: readonly SessionStreamEvent[]) => boolean,
): Promise<SessionStreamEvent[]> {
  const reader = events.getReader();
  const seen: SessionStreamEvent[] = [];
  try {
    while (!done(seen)) {
      const next = await reader.read();
      if (next.done) break;
      seen.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return seen;
}

/** Whether the session's turn settled after it said `text`. */
const replied = (text: string) => (seen: readonly SessionStreamEvent[]) =>
  JSON.stringify(seen).includes(text) && seen.some((event) => event.type === "turn.settled");

describe("dynamic schedules on a World host", () => {
  it("keeps a schedule a session made, and runs each occurrence once in a session of its own", async () => {
    const outbox = defineChannel<undefined, void, { inbox: string }>({
      routes: [POST("/outbox", async () => new Response("ok"))],
      async receive({ message, target, ...send }, { from }) {
        return await from(target.inbox).send(message, send);
      },
    });
    const digests = defineDynamicSchedules({
      auth: () => alice,
      inputSchema: z.object({ task: z.string() }),
      provider: worldScheduleProvider(),
      async run({ payload, to }) {
        await to(outbox, { inbox: "team" }).send(payload.task);
      },
    });
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const text = JSON.stringify(prompt);
          if (text.includes("weekly digest")) return textStreamResult("Here is the digest.");
          return prompt.some((message) => message.role === "tool")
            ? textStreamResult("Scheduled.")
            : toolCallsStreamResult([{ input: "{}", toolCallId: "call-plan", toolName: "plan" }]);
        },
        modelId: "world-host-schedules",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "planner",
      },
      modules: [
        { loadNamespace: async () => ({ default: outbox }), logicalPath: "channels/outbox.ts" },
        { loadNamespace: async () => ({ default: digests }), logicalPath: "schedules/digests.ts" },
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Schedules the weekly digest.",
              inputSchema: { properties: {}, type: "object" },
              async execute() {
                const client = await schedules(digests);
                const created = await client.create({
                  expression: { cron: "* * * * *", type: "cron" },
                  name: "weekly",
                  payload: { task: "Write the weekly digest." },
                });
                return { name: created.name };
              },
            }),
          }),
          logicalPath: "tools/plan.ts",
        },
      ],
    });
    await test.run(async () => {
      host = createWorldHost({
        compiledAgents: { planner: createBundledRuntimeCompiledArtifactsSource() },
        world: localWorld({ dataDir: join(dir, "world") }),
      });
      await host.serve();
      const planned = await (
        await host.session("planner", { identity: alice }).send("Plan our digests.")
      ).result();
      expect(planned.reply).toBe("Scheduled.");

      const at = new Date();
      expect(await host.tick(at)).toHaveLength(1);
      // Another tick in the same minute, here or in any process, runs nothing.
      expect(await host.tick(at)).toEqual([]);

      // The occurrence started a session of its own, through the channel.
      const sessions = (await host.entities.list()).map((entity) => entity.key);
      const scheduled = sessions.find((key) => key !== planned.sessionId);
      expect(sessions).toHaveLength(2);
      const events = await eventsUntil(
        await host.runtime("planner").getEventStream(scheduled!, {}),
        replied("Here is the digest."),
      );
      expect(JSON.stringify(events)).toContain("Here is the digest.");
    });
  }, 60_000);
});

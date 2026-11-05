import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { eve } from "#definitions/defaults.js";
import { codeAgent } from "#embed/agent.js";
import { createSession } from "#embed/session.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { asRuntimeWorld } from "#execution/world/world-fit.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { memorySandbox } from "#runtime/sandbox/memory-sandbox.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

// Suspending a session is not ending it. Alice's lead agent writes a plan in its memory sandbox,
// then asks to ship it. Suspended while it waits for her approval, kept on Workflow's local
// World, the session resumes in a fresh runtime with its files: nothing was torn down. Closing it
// ends it.

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

/**
 * The lead: writes `plan.md`, asks to ship (which needs approval), then reads `plan.md` back and
 * replies with what it read.
 */
function leadAgent() {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []))
            : [],
        );
        if (results.length >= 3)
          return textStreamResult(`Read: ${JSON.stringify(results.at(-1)?.output)}`);
        const steps = [
          {
            input: JSON.stringify({ content: "Ship on Friday.\n", filePath: "plan.md" }),
            toolCallId: "call-write",
            toolName: "write_file",
          },
          { input: JSON.stringify({ env: "prod" }), toolCallId: "call-ship", toolName: "ship" },
          {
            input: JSON.stringify({ filePath: "plan.md" }),
            toolCallId: "call-read",
            toolName: "read_file",
          },
        ];
        return toolCallsStreamResult([steps[results.length]!]);
      },
      modelId: "lead",
      provider: "eve-test",
    }),
  );
  return codeAgent({
    definitions: eve.defaults({
      sandbox: memorySandbox(),
      without: ["bash", "web_fetch", "web_search"],
    }),
    model: { model, modelContextWindowTokens: 200_000 },
    name: "lead",
    tools: {
      ship: defineTool({
        approval: always(),
        description: "Ship the plan.",
        execute: async () => ({ shipped: true }),
        inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      }),
    },
  });
}

/** Every line `world` kept of `sessionId`. */
async function linesOf(world: RuntimeWorld, sessionId: string): Promise<string> {
  return ((await createWorldSessionStore(world).load(sessionId))?.lines ?? []).join("\n");
}

/** Workflow's local World, in `directory`. */
const localWorld = (directory: string) =>
  asRuntimeWorld(createWorld({ dataDir: directory, recoverActiveRuns: false }));

describe("suspending and ending an embedded session", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eve-suspend-"));
  });
  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("suspends a kept session with its sandbox files, which a fresh runtime continues", async () => {
    const lead = leadAgent();
    const world = localWorld(directory);
    const first = createSession(lead, { identity: alice, world });
    const asked = await (await first.send("Write the plan, then ship it.")).result();
    expect(asked.interactions.map((interaction) => interaction.call?.name)).toEqual(["ship"]);
    // Once the loop recorded its pause, the process quits while Alice decides: nothing of the
    // session is torn down.
    expect((await first.snapshot()).open).toMatchObject({ at: "pause" });
    await first.suspend();
    const saved = await createWorldSessionStore(localWorld(directory)).load(asked.sessionId);
    expect(saved?.open).toMatchObject({ at: "pause", pause: { on: "interaction" } });
    expect(await linesOf(world, asked.sessionId)).not.toContain('"session.ended"');

    // Another process's World on the same directory.
    const second = createSession(lead, {
      identity: alice,
      resume: asked.sessionId,
      world: localWorld(directory),
    });
    try {
      const [pending] = await second.pending();
      const answered = await (
        await second.respond([{ interactionId: pending!.interactionId, optionId: "approve" }])
      ).result();
      // The plan the first runtime wrote is still in the sandbox.
      expect(answered.reply).toContain("Ship on Friday.");
    } finally {
      await second.close();
    }
  }, 60_000);

  it("ends a session on close", async () => {
    const world = localWorld(directory);
    const session = createSession(leadAgent(), { identity: alice, world });
    const asked = await (await session.send("Write the plan, then ship it.")).result();
    expect(await linesOf(world, asked.sessionId)).not.toContain('"session.ended"');

    await session.close();
    expect(await linesOf(world, asked.sessionId)).toContain('"session.ended"');
  }, 60_000);
});

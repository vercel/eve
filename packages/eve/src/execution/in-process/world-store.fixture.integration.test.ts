import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { JournalRecord } from "#execution/actor/actors.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { sessionActors } from "#execution/world/session-actors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { address, violations } from "#internal/testing/in-process-sessions.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { createInProcessRuntime } from "./runtime.js";
import {
  createWorldSessionStore,
  SESSION_RECORD_VERSION,
  SessionRecordVersionError,
} from "./world-store.js";

// What a session's journal holds is the contract between the build that saved it and the one
// that continues it: sessions always resume on the latest code. The fixture is a session this
// format saved, waiting on an approval: its journal's records (from its latest snapshot on) and
// its stream's lines. Each build must load and continue it, and a format change that breaks it
// needs a migration (`RECORD_MIGRATIONS` in `world-store.ts`).
//
// To capture it again after a deliberate format change (with its migration), run this file with
// `EVE_UPDATE_SESSION_FIXTURE=1`.

const FIXTURE = fileURLToPath(new URL("./fixtures/session-record-v1.json", import.meta.url));

interface SessionFixture {
  readonly version: number;
  readonly sessionId: string;
  readonly snapshot: JournalRecord;
  readonly after: readonly JournalRecord[];
  readonly lines: readonly string[];
}

const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const results = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [`${part.toolName}:${part.output.type}`] : [],
            )
          : [],
      );
      return results.length > 0
        ? textStreamResult(`Done: ${results.join(", ")}.`)
        : toolCallsStreamResult([
            { input: "{}", toolCallId: "call-deploy", toolName: "deploy_change" },
          ]);
    },
    modelId: "session-fixture",
    provider: "eve-test",
  }),
);

async function fixtureRuntime(ran: string[]) {
  return await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "session-fixture",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            approval: always(),
            description: "Deploy the change.",
            execute: async () => {
              ran.push("deploy_change");
              return { deployed: true };
            },
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/deploy_change.ts",
      },
    ],
  });
}

const capturing = process.env.EVE_UPDATE_SESSION_FIXTURE === "1";

describe("a session saved by this format", () => {
  it.runIf(capturing)("is captured as the fixture", async () => {
    const test = await fixtureRuntime([]);
    await test.run(async () => {
      const world = memoryWorld();
      const runtime = createInProcessRuntime(
        { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
        { world },
      );
      const asked = await (
        await address(runtime, "alice-fixture").send("Deploy the change.", { auth: null })
      ).result();
      expect(asked.interactions).toHaveLength(1);
      await runtime.idle(asked.sessionId);
      await runtime.dispose();
      const actors = sessionActors(world);
      const journal = (await actors.load(asked.sessionId))!;
      const decoder = new TextDecoder();
      const fixture: SessionFixture = {
        after: journal.after,
        lines: (await actors.chunks(asked.sessionId)).map((line) => decoder.decode(line)),
        sessionId: asked.sessionId,
        snapshot: journal.snapshot!,
        version: SESSION_RECORD_VERSION,
      };
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    });
  });

  it.skipIf(capturing)("loads, and continues where it waited", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as SessionFixture;
    const ran: string[] = [];
    const test = await fixtureRuntime(ran);
    await test.run(async () => {
      // The World holds what the fixture's session saved, as another process left it.
      const world = memoryWorld();
      const actors = sessionActors(world);
      const handle = await actors.open(fixture.sessionId);
      await handle.append([fixture.snapshot], { snapshot: true });
      if (fixture.after.length > 0) await handle.append(fixture.after);
      const encoder = new TextEncoder();
      await handle.stream.append(
        0,
        fixture.lines.map((line) => encoder.encode(line)),
      );

      const runtime = createInProcessRuntime(
        { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
        { world },
      );
      try {
        const saved = await runtime.load(fixture.sessionId);
        expect(saved?.open).toMatchObject({ at: "pause", pause: { on: "interaction" } });
        await runtime.restore(saved!);
        const open = saved!.open;
        if (open?.at !== "pause" || open.pause.on !== "interaction")
          throw new Error("The fixture's session waits on an interaction.");
        const requestId = open.pause.requestIds[0]!;
        const answered = await (
          await address(runtime, "alice-fixture").deliver(
            { answers: [{ interactionId: requestId, optionId: "approve" }] },
            { auth: null },
          )
        ).result();
        expect(answered.reply).toBe("Done: deploy_change:json.");
        expect(ran).toEqual(["deploy_change"]);
        await expect(violations(runtime, fixture.sessionId)).resolves.toEqual([]);
      } finally {
        await runtime.dispose({ suspend: false });
      }
    });
  });

  it("reads a record written before records carried a version, and refuses a newer one", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as SessionFixture;
    const bare = (record: JournalRecord): JournalRecord => ({
      kind: record.kind,
      value: (record.value as { readonly b: unknown }).b,
    });
    const load = async (snapshot: JournalRecord) => {
      const world = memoryWorld();
      const handle = await sessionActors(world).open(fixture.sessionId);
      await handle.append([snapshot], { snapshot: true });
      return await createWorldSessionStore(world).load(fixture.sessionId);
    };
    const current = await load(fixture.snapshot);
    expect(await load(bare(fixture.snapshot))).toEqual(current);
    await expect(
      load({ kind: fixture.snapshot.kind, value: { b: {}, v: SESSION_RECORD_VERSION + 1 } }),
    ).rejects.toBeInstanceOf(SessionRecordVersionError);
  });
});

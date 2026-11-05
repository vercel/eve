import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { createChannelAddress } from "#channel/channel-address.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { memoryWorld } from "./memory-world.js";
import type { RuntimeWorld } from "./runtime-world.js";
import { sessionEntities } from "./session-entities.js";
import { asRuntimeWorld } from "./world-fit.js";

// The in-process host keeps each session as a run on its World. The same conversation runs on
// `memoryWorld()` and on Workflow's local World, so the memory World is checked against a real
// one: each World's stream holds exactly the lines the session's readers see.

async function linesSeen(world: RuntimeWorld) {
  const runtime = createInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    { world },
  );
  try {
    const alice = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: "alice",
      runtime,
    });
    let sessionId = "";
    for (const message of ["Alice asks for the weekly summary.", "Bob asks again."]) {
      const delivery = await alice.send(message, { auth: null });
      sessionId = delivery.sessionId;
      await delivery.result();
    }
    const read = [];
    for await (const record of await runtime.getLineStream(sessionId, { follow: false }))
      read.push(record);
    const decoder = new TextDecoder();
    const kept = (await sessionEntities(world).chunks(sessionId)).map((line) =>
      JSON.parse(decoder.decode(line)),
    );
    const sessions = (await sessionEntities(world).list()).map((session) => session.key);
    return { kept, read, sessionId, sessions };
  } finally {
    await runtime.dispose();
  }
}

describe("an in-process session on a World", () => {
  it("keeps every line its readers see, on the memory World and on Workflow's local World", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-world" } });
    const dataDir = await mkdtemp(join(tmpdir(), "eve-world-local-"));
    try {
      await test.run(async () => {
        const inMemory = await linesSeen(memoryWorld());
        const local = await linesSeen(
          asRuntimeWorld(createWorld({ dataDir, recoverActiveRuns: false })),
        );
        for (const run of [inMemory, local]) {
          expect(run.read.length).toBeGreaterThan(0);
          expect(run.kept).toEqual(run.read);
          expect(run.sessions).toEqual([run.sessionId]);
        }
        expect(local.kept.length).toBe(inMemory.kept.length);
      });
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });
});

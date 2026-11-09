import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { localTestWorld } from "#internal/testing/local-world.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { memoryWorld } from "./memory-world.js";
import type { RuntimeWorld } from "./runtime-world.js";
import { sessionEntities } from "./session-entities.js";

// One process writes a session at a time. A process that continues a session claims it first
// (opening its entity, the first write of a restore), and the World refuses the writes of the
// process that ran it before: its next message fails, saying the session continued elsewhere,
// and nothing of it reaches the stream. (Two runtimes in one process can't hold one session's
// stream, so the other process here is its claim.)

const alice = (runtime: Runtime) =>
  createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken: "alice",
    runtime,
  });

async function takenOver(world: RuntimeWorld) {
  const runtime = createInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    { world },
  );
  try {
    const sent = await alice(runtime).send("Alice asks for the weekly summary.", { auth: null });
    await sent.result();
    const { sessionId } = sent;
    const before = (await sessionEntities(world).chunks(sessionId)).length;

    // Another process continues the session while this runtime still runs it.
    await sessionEntities(world).open(sessionId);

    const refused = await alice(runtime)
      .send("Alice asks again.", { auth: null })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const after = (await sessionEntities(world).chunks(sessionId)).length;
    return { after, before, refused };
  } finally {
    await runtime.dispose();
  }
}

describe("one writer per session", () => {
  it("refuses the writes of a runtime whose session another runtime continued", async () => {
    const test = await createTestRuntime({ agent: { name: "single-writer" } });
    const dataDir = await mkdtemp(join(tmpdir(), "eve-single-writer-"));
    try {
      await test.run(async () => {
        for (const world of [memoryWorld(), localTestWorld(dataDir)]) {
          const run = await takenOver(world);
          expect(run.before).toBeGreaterThan(0);
          expect(String(run.refused)).toContain("continued by another process");
          // Nothing of the refused message reached the stream.
          expect(run.after).toBe(run.before);
        }
      });
    } finally {
      await rm(dataDir, { force: true, recursive: true });
    }
  });
});

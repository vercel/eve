import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { forgetSessionLive } from "#definitions/state.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  ALICE_ASKS,
  crashAgent,
  crashShape,
  RETRIED_TOOL_STEP_SHAPE,
} from "#internal/testing/in-process-crash/agent.js";
import { getWorld } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

// Workflow's side of `crash.scenario.test.ts`: the turn whose tool step loses its completion once,
// the way `step-retry-owner.integration.test.ts` loses one, streams what the in-process host
// continues to after a kill -9 at the same point.
it("retries a tool step that lost its completion with the stream an in-process continuation matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eve-crash-workflow-"));
  const test = await createTestRuntime(crashAgent(dir));
  const events = await test.run(async () => {
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const create = world.events.create.bind(world.events);
    let turnSteps = 0;
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args;
      if (
        event.eventType === "step_completed" &&
        event.eventData.stepName?.includes("turnStep") === true &&
        ++turnSteps === 1
      ) {
        // The first turn step ran `deploy` and published its result; its process died before
        // the step's completion was recorded.
        forgetSessionLive(runId);
        throw new Error("Process exited after publication, before checkpoint");
      }
      return await create(...args);
    });
    try {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const sent = await createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: "alice-workflow",
        runtime,
      }).send(ALICE_ASKS, { auth: null });
      await sent.result();
      return await recorded(runtime, sent.sessionId);
    } finally {
      spy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
  expect(lines(join(dir, "ran.log"))).toEqual(["deploy"]);
  expect(lines(join(dir, "prompts.log"))[1]).toContain("its result was lost");
  expect(crashShape(events)).toEqual(RETRIED_TOOL_STEP_SHAPE);
});

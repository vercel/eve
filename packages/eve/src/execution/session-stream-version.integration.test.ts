import { describe, expect, it, vi } from "vitest";

import { createSession } from "#channel/session.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import {
  EVE_STREAM_VERSION_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { sessionCommandInboxWorkflow } from "#internal/testing/session-inbox-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const at = "2026-11-26T00:00:00.000Z";

async function writeLines(runId: string, lines: readonly unknown[]): Promise<void> {
  const ops: Promise<void>[] = [];
  const writer = getRun(runId).getWritable<Uint8Array>({ ops }).getWriter();
  const encoder = new TextEncoder();
  try {
    for (const line of lines) {
      await writer.write(encoder.encode(`${JSON.stringify(line)}\n`));
    }
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}

describe("session stream version resolution against workflow world", () => {
  it("stamps $eve.stream_version on new sessions and skips startIndex=0 reads on cold instances", async () => {
    const test = await createTestRuntime({ agent: { name: "stream-version-new" } });
    await test.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const world = await getWorld();
      const created = await runtime.createSession({
        adapter: { kind: "http" },
        auth: null,
        input: { message: "hello" },
      });
      try {
        const stored = await world.runs.get(created.sessionId, { resolveData: "none" });
        expect(stored.attributes[EVE_STREAM_VERSION_ATTRIBUTE]).toBe("27");
        expect(stored.attributes[EVE_VERSION_ATTRIBUTE]).toBeTruthy();
        await expect(runtime.getStreamVersion!(created.sessionId)).resolves.toBe("27");

        await writeLines(created.sessionId, [
          { at, facts: [{ data: { deliveryId: "d0" }, type: "delivery.admitted" }] },
          { at, facts: [{ data: { deliveryId: "d1" }, type: "delivery.admitted" }] },
        ]);

        const streamGets: Array<number | undefined> = [];
        const originalGet = world.streams.get.bind(world.streams);
        const spy = vi.spyOn(world.streams, "get").mockImplementation((...args) => {
          streamGets.push(args[2]);
          return originalGet(...args);
        });

        try {
          const response = await createSessionStreamResponse(
            new Request(
              `https://eve.test/eve/v1/session/${created.sessionId}/stream?follow=false&startIndex=1`,
            ),
            createSession(created.sessionId, runtime),
          );
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain('"deliveryId":"d1"');
          expect(streamGets).toEqual([1]);
        } finally {
          spy.mockRestore();
        }
      } finally {
        await runtime.dispatchSession({
          command: { deliveryId: "reset-1", kind: "reset" },
          sessionId: created.sessionId,
        });
      }
    });
  });

  it("classifies existing 1.0.0-rc.6 runs without $eve.stream_version as v27 and skips startIndex=0", async () => {
    const test = await createTestRuntime({ agent: { name: "stream-version-rc6" } });
    await test.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const world = await getWorld();
      const token = "http:stream-version-rc6";
      const run = await start(sessionCommandInboxWorkflow, [{ token }], {
        allowReservedAttributes: true,
        attributes: { [EVE_VERSION_ATTRIBUTE]: "1.0.0-rc.6" },
      });
      await waitForHook(run, { token: sessionInboxHookToken(token) });
      try {
        const stored = await world.runs.get(run.runId, { resolveData: "none" });
        expect(stored.attributes[EVE_STREAM_VERSION_ATTRIBUTE]).toBeUndefined();
        expect(stored.attributes[EVE_VERSION_ATTRIBUTE]).toBe("1.0.0-rc.6");
        await expect(runtime.getStreamVersion!(run.runId)).resolves.toBe("27");

        await writeLines(run.runId, [
          { at, facts: [{ data: { deliveryId: "d0" }, type: "delivery.admitted" }] },
          { at, facts: [{ data: { deliveryId: "d1" }, type: "delivery.admitted" }] },
        ]);

        const streamGets: Array<number | undefined> = [];
        const originalGet = world.streams.get.bind(world.streams);
        const spy = vi.spyOn(world.streams, "get").mockImplementation((...args) => {
          streamGets.push(args[2]);
          return originalGet(...args);
        });

        try {
          const response = await createSessionStreamResponse(
            new Request(
              `https://eve.test/eve/v1/session/${run.runId}/stream?follow=false&startIndex=1`,
            ),
            createSession(run.runId, runtime),
          );
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain('"deliveryId":"d1"');
          expect(streamGets).toEqual([1]);
        } finally {
          spy.mockRestore();
        }
      } finally {
        await run.cancel().catch(() => {});
      }
    });
  });

  it("falls back to reading line 0 for pre-0.84.0 runs", async () => {
    const test = await createTestRuntime({ agent: { name: "stream-version-v26" } });
    await test.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const world = await getWorld();
      const token = "http:stream-version-v26";
      const run = await start(sessionCommandInboxWorkflow, [{ token }], {
        allowReservedAttributes: true,
        attributes: { [EVE_VERSION_ATTRIBUTE]: "0.71.0" },
      });
      await waitForHook(run, { token: sessionInboxHookToken(token) });
      try {
        await expect(runtime.getStreamVersion!(run.runId)).resolves.toBeUndefined();

        await writeLines(run.runId, [
          { data: {}, meta: { at }, type: "session.started" },
          { data: { sequence: 0, turnId: "turn_0" }, meta: { at }, type: "turn.started" },
          {
            data: { message: "Alice asks.", sequence: 0, turnId: "turn_0" },
            meta: { at, deliveryIds: ["delivery_1"] },
            type: "message.received",
          },
        ]);

        const streamGets: Array<number | undefined> = [];
        const originalGet = world.streams.get.bind(world.streams);
        const spy = vi.spyOn(world.streams, "get").mockImplementation((...args) => {
          streamGets.push(args[2]);
          return originalGet(...args);
        });

        try {
          const response = await createSessionStreamResponse(
            new Request(
              `https://eve.test/eve/v1/session/${run.runId}/stream?follow=false&startIndex=2`,
            ),
            createSession(run.runId, runtime),
          );
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain('"type":"delivery.consumed"');
          expect(streamGets).toContain(0);
        } finally {
          spy.mockRestore();
        }
      } finally {
        await run.cancel().catch(() => {});
      }
    });
  });
});

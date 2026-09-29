import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readLocalObservationPage } from "#execution/run-observation/read-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { runObservationConcurrencyProof } from "#internal/testing/run-observation-proof-workflow.js";
import { runObservationSourceWorkflow } from "#internal/testing/run-observation-source-workflow.js";

/** The observer must return without waiting for a parked source stream to close. */
describe("local observation read", () => {
  it("captures an empty tail without opening a follow-forever reader", async () => {
    const runtime = await createTestRuntime({ agent: { name: "observation-read" } });
    await runtime.run(async () => {
      const run = await start(runObservationConcurrencyProof, [
        { ownerToken: `eve:read:${randomUUID()}` },
      ]);
      try {
        const empty = await readLocalObservationPage({ sessionId: run.runId, startIndex: 0 });
        expect(empty).toEqual({
          capturedTail: -1,
          nextIndex: 0,
          records: [],
          outcome: "caught-up",
        });
        expect(await getRun(run.runId).status).not.toBe("completed");
      } finally {
        await run.cancel();
      }
    });
  });

  it("resumes from the saved absolute index after a bounded page", async () => {
    const runtime = await createTestRuntime({ agent: { name: "observation-stream-read" } });
    await runtime.run(async () => {
      const ownerToken = `eve:read:${randomUUID()}`;
      const run = await start(runObservationConcurrencyProof, [
        { ownerToken, emitStreamEvent: true },
      ]);
      try {
        await waitForHook(run, { token: ownerToken });
        const deadline = Date.now() + 10_000;
        let page = await readLocalObservationPage({ sessionId: run.runId, startIndex: 0 });
        while (page.nextIndex === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          page = await readLocalObservationPage({ sessionId: run.runId, startIndex: 0 });
        }
        expect(page.records[0]).toMatchObject({ index: 0, event: { type: "turn.started" } });
        const next = await readLocalObservationPage({
          sessionId: run.runId,
          startIndex: page.nextIndex,
        });
        expect(next.records.every((record) => record.index >= page.nextIndex)).toBe(true);
      } finally {
        await run.cancel();
      }
    });
  });

  it("returns a complete prefix without consuming a malformed trailing source record", async () => {
    const runtime = await createTestRuntime({ agent: { name: "observation-partial-read" } });
    await runtime.run(async () => {
      const run = await start(runObservationSourceWorkflow, [{ malformedAfterFirst: true }]);
      await run.returnValue;
      const page = await readLocalObservationPage({ sessionId: run.runId, startIndex: 0 });
      expect(page).toMatchObject({
        capturedTail: 1,
        outcome: "partial",
        nextIndex: 1,
        records: [{ index: 0, event: { type: "turn.started" } }],
      });
    });
  });
});

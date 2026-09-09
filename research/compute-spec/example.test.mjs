import assert from "node:assert/strict";
import test from "node:test";
import { reportTask } from "./example.ts";

test("report recovers from a saved effect result without another invocation", async () => {
  const ledger = new Map();
  let checkpoint;
  let invocations = 0;
  let loseNextCheckpoint = true;
  const context = {
    async effect(request) {
      checkpoint = structuredClone(request.checkpoint);
      const identity = JSON.stringify([request.definition, request.inputVersion, request.input]);
      const saved = ledger.get(request.key);
      if (saved) {
        assert.equal(saved.identity, identity);
        return saved.result;
      }
      invocations++;
      const result = { value: "Quarterly report", resultRef: "result-1" };
      ledger.set(request.key, { identity, result });
      return result;
    },
    async checkpoint(value) {
      if (loseNextCheckpoint) {
        loseNextCheckpoint = false;
        throw new Error("simulated process loss");
      }
      checkpoint = structuredClone(value);
    },
  };
  const input = { reportId: "report-1" };
  await assert.rejects(reportTask.start(input, context), /simulated process loss/);
  assert.equal(checkpoint.phase, "fetch");
  assert.equal(await reportTask.resume(input, checkpoint, context), "Quarterly report");
  assert.equal(invocations, 1);
  assert.equal(checkpoint.phase, "finished");
  assert.equal(await reportTask.resume(input, checkpoint, context), "Quarterly report");
  assert.equal(invocations, 1);
});

test("unknown checkpoint phases and versions fail explicitly", () => {
  assert.throws(
    () => reportTask.migrateCheckpoint(1, { phase: "unknown", reportId: "report-1" }),
    /Unknown report checkpoint/,
  );
  assert.throws(
    () => reportTask.migrateCheckpoint(2, { phase: "fetch", reportId: "report-1" }),
    /Unsupported data version/,
  );
  assert.throws(() => reportTask.inputSchema.parse({ reportId: "" }), /Expected a reportId/);
  assert.throws(() => reportTask.outputSchema.parse({ text: "report" }), /Expected report text/);
});

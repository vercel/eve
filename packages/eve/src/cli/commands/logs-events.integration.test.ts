import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import { getRun, setWorld } from "#internal/workflow/runtime.js";
import { encodeLine } from "#protocol/session-events/envelope.js";

import { readDevSessionEvents } from "./logs-events.js";

describe("readDevSessionEvents", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("returns an empty list without creating a store when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-logs-events-"));
    roots.push(root);

    const events = await readDevSessionEvents(root, {
      from: new Date(0),
      to: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(events).toEqual([]);
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(resolveLocalWorkflowWorldDataDirectory(root)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips runs without session streams via the listStreams prefilter", async () => {
    // A run with no session stream contributes nothing and costs a directory
    // listing, not an idle-timeout wait.
    const root = await mkdtemp(join(tmpdir(), "eve-logs-events-"));
    roots.push(root);
    const world = createWorld({ dataDir: resolveLocalWorkflowWorldDataDirectory(root) });
    await world.events.create(null, {
      eventType: "run_created",
      eventData: {
        deploymentId: "dpl_test",
        workflowName: "sessionWorkflow",
        input: [],
      },
    });

    const startedAt = Date.now();
    const events = await readDevSessionEvents(root, {
      from: new Date(startedAt - 60_000),
      to: new Date(startedAt + 60_000),
    });

    expect(events).toEqual([]);
    // The prefilter answers from storage; no stream is ever opened.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("skips a run an eve before v27 recorded and keeps reading v27 runs", async () => {
    const logs = captureLogRecords();
    const root = await mkdtemp(join(tmpdir(), "eve-logs-events-"));
    roots.push(root);
    const world = createWorld({ dataDir: resolveLocalWorkflowWorldDataDirectory(root) });
    setWorld(world);
    const at = new Date().toISOString();
    const startRun = async (lines: readonly string[]) => {
      const created = await world.events.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "dpl_test", workflowName: "sessionWorkflow", input: [] },
      });
      const runId = created.run!.runId;
      // `close()` settles before the background pipe lands chunks in the
      // world; `ops` settles once they are durable.
      const ops: Promise<unknown>[] = [];
      const writer = getRun(runId).getWritable<Uint8Array>({ ops }).getWriter();
      for (const line of lines) await writer.write(new TextEncoder().encode(line));
      await writer.close();
      await Promise.all(ops);
      return runId;
    };
    // A stranded reset appends a v27 line after the history an earlier eve recorded.
    const legacyRunId = await startRun([
      `${JSON.stringify({ data: {}, meta: { at, id: "evt_0" }, type: "session.started" })}\n`,
      encodeLine({ at, facts: [{ data: { outcome: "failed" }, type: "session.ended" }] }),
    ]);
    const currentRunId = await startRun([
      encodeLine({ at, facts: [{ data: { deliveryId: "d0" }, type: "delivery.admitted" }] }),
    ]);

    const events = await readDevSessionEvents(root, {
      from: new Date(Date.parse(at) - 60_000),
      to: new Date(Date.parse(at) + 60_000),
    });

    expect(events).toEqual([
      {
        at,
        data: { deliveryId: "d0" },
        runId: currentRunId,
        source: "event",
        type: "delivery.admitted",
      },
    ]);
    expect(logs.records).toMatchObject([
      {
        level: "warn",
        message: expect.stringContaining(`Skipped run ${legacyRunId}`),
      },
    ]);
  });
});

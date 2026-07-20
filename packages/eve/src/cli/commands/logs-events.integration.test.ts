import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

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

  it("drains runs without session streams via the idle timeout instead of hanging", async () => {
    // A hermetic happy-path test would need serde-encoded chunks, which only
    // real workflow execution produces (`getWritable` is workflow-context
    // only); the decode path is exercised against real stores by the TUI
    // smoke flows. This pins the failure-mode invariants instead: a run with
    // no session stream contributes nothing, and an unclosed/absent stream
    // cannot hang the CLI read.
    const root = await mkdtemp(join(tmpdir(), "eve-logs-events-"));
    roots.push(root);
    const world = createWorld({ dataDir: resolveLocalWorkflowWorldDataDirectory(root) });
    await world.events.create(null, {
      eventType: "run_created",
      eventData: {
        deploymentId: "dpl_test",
        workflowName: "turnWorkflow",
        input: [],
      },
    });

    const startedAt = Date.now();
    const events = await readDevSessionEvents(root, {
      from: new Date(startedAt - 60_000),
      to: new Date(startedAt + 60_000),
    });

    expect(events).toEqual([]);
    // One idle-timeout budget, not an unbounded wait.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

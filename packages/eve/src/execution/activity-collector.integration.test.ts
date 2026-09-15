import { describe, expect, it } from "vitest";

import {
  ACTIVITY_SNAPSHOT_STREAM_NAMESPACE,
  activityCollectorWorkflow,
} from "#execution/activity-collector.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import type { ActivityBatchV1, ActivitySnapshotV1 } from "#protocol/activity.js";

describe("activityCollectorWorkflow", () => {
  it("publishes revision-changing snapshots to its named durable stream", async () => {
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const token = "activity-collector-integration";
      const run = await start(activityCollectorWorkflow, [
        { expiresAt: "2099-01-01T00:00:00.000Z", serializedContext: {}, token },
      ]);
      await waitForHook({ runId: run.runId }, { token });
      const work = {
        id: "root:work",
        kind: "root-turn" as const,
        rootSessionId: "session",
        rootTurnId: "turn",
      };
      const batch: ActivityBatchV1 = {
        events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
        version: 1,
      };

      try {
        await resumeHook(token, batch);
        const stream = getRun(run.runId).getReadable({
          namespace: ACTIVITY_SNAPSHOT_STREAM_NAMESPACE,
        });
        const reader = stream.getReader();
        const result = await reader.read();
        const snapshot = result.value as ActivitySnapshotV1;

        expect(snapshot.revision).toBe(1);
        expect(snapshot.work[work.id]).toMatchObject({ phase: "running", ...work });
        await reader.cancel();
      } finally {
        await run.cancel();
      }
    });
  });
});

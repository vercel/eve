import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adjacentSpikeCompanion,
  adjacentSpikeTurn,
  adjacentSpikeClosingOwner,
} from "#internal/testing/adjacent-workflow-spike.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { start, getRun, getHookByToken, resumeHook, getWorld } from "#internal/workflow/runtime.js";

describe("adjacent workflow research spike", () => {
  it("shares a companion stream and checkpoint between independent terminating runs, and claims an alias", async () => {
    const token = `adjacent-spike:${randomUUID()}`;
    const companion = await start(adjacentSpikeCompanion, [token]);
    try {
      await waitForHook(companion, { token });
      const first = await start(adjacentSpikeTurn, [companion.runId, "first"]);
      expect(await first.returnValue).toBe(1);
      const second = await start(adjacentSpikeTurn, [companion.runId, "second"]);
      expect(await second.returnValue).toBe(2);
      const reader = companion.getReadable<string>().getReader();
      expect((await reader.read()).value).toBe("first");
      expect((await reader.read()).value).toBe("second");
      await reader.cancel();
      const alias = `${token}:alias`;
      await resumeHook(token, { alias });
      await waitForHook(companion, { token: alias });
      expect((await getHookByToken(alias)).runId).toBe(companion.runId);
      expect(await companion.status).toBe("running");
      await resumeHook(token, { close: true });
      await companion.returnValue;
    } finally {
      if (["pending", "running"].includes(await companion.status)) await companion.cancel();
    }
  });

  it("a successful resume does not imply the ending owner applied the message", async () => {
    const token = `adjacent-spike:${randomUUID()}`;
    const owner = await start(adjacentSpikeClosingOwner, [token]);
    try {
      await waitForHook(owner, { token: `${token}:finish` });
      const receipt = await resumeHook(token, "late message");
      expect(receipt.runId).toBe(owner.runId);
      await resumeHook(`${token}:finish`, {});
      expect(await owner.returnValue).toEqual([]);
      const events = await (
        await getWorld()
      ).events.list({ runId: owner.runId, pagination: { limit: 100 } });
      expect(events.data.filter((event) => event.eventType === "hook_received")).toHaveLength(2);
    } finally {
      if (["pending", "running"].includes(await owner.status)) await owner.cancel();
    }
  });

  it("replaces a completed holder while retaining its stream, checkpoint, cursor, and provider address", async () => {
    const token = `adjacent-spike:${randomUUID()}`;
    const original = await start(adjacentSpikeCompanion, [token]);
    let replacement: typeof original | undefined;
    const reader = original.getReadable<string>().getReader();
    try {
      await waitForHook(original, { token });
      const first = await start(adjacentSpikeTurn, [original.runId, "before replacement"]);
      expect(await first.returnValue).toBe(1);
      expect((await reader.read()).value).toBe("before replacement");
      const tail = original.getReadable<string>();
      const cursor = (await tail.getTailIndex()) + 1;
      await tail.cancel();
      await resumeHook(token, { close: true });
      await original.returnValue;
      expect(await original.status).toBe("completed");

      replacement = await start(adjacentSpikeCompanion, [token, original.runId]);
      await waitForHook(replacement, { token });
      const owner = await getHookByToken(token);
      expect(owner.runId).toBe(replacement.runId);
      expect(owner.runId).not.toBe(original.runId);
      const referenceReader = getRun(owner.runId)
        .getReadable<{ sessionId: string; streamRunId: string }>({ namespace: "session-reference" })
        .getReader();
      const { value: reference } = await referenceReader.read();
      await referenceReader.cancel();
      expect(reference).toEqual({ sessionId: original.runId, streamRunId: original.runId });
      const second = await start(adjacentSpikeTurn, [reference!.streamRunId, "after replacement"]);
      expect(await second.returnValue).toBe(2);
      expect((await reader.read()).value).toBe("after replacement");
      const resumed = original.getReadable<string>({ startIndex: cursor }).getReader();
      expect((await resumed.read()).value).toBe("after replacement");
      await resumed.cancel();
      await resumeHook(token, { close: true });
      await replacement.returnValue;
    } finally {
      await reader.cancel();
      for (const run of [original, replacement]) {
        if (run && ["pending", "running"].includes(await run.status)) await run.cancel();
      }
    }
  });
});

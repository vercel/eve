import { describe, expect, it, vi } from "vitest";

import { createProgressEventBuffer } from "#execution/progress-event-buffer.js";
import { MAX_PROGRESS_EVENTS_PER_BATCH } from "#protocol/progress.js";

const event = (index: number) => ({
  eventId: `event:${String(index)}`,
  kind: "work.settled" as const,
  outcome: "completed" as const,
  settledAt: "now",
  workId: `work:${String(index)}`,
});

describe("progress event buffer", () => {
  it("submits bounded batches and flushes the remainder", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const buffer = createProgressEventBuffer({ submit });
    const events = Array.from({ length: MAX_PROGRESS_EVENTS_PER_BATCH + 2 }, (_, index) =>
      event(index),
    );
    await buffer.push(events);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0]).toHaveLength(MAX_PROGRESS_EVENTS_PER_BATCH);
    await buffer.flush();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toEqual(events.slice(MAX_PROGRESS_EVENTS_PER_BATCH));
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createLocalDevScheduleDispatcher,
  parsePersistedSchedulePayload,
} from "#internal/schedules/local-dev-dispatch.js";
import { PermanentScheduleMessageError } from "#internal/schedules/verify-delivery.js";
import { ScheduleCollectionNotDeployedError } from "#runtime/schedules/load-collection.js";

function setup(deliver: () => Promise<void>, closed = false) {
  const fail = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  const dispatch = createLocalDevScheduleDispatcher({
    deliver,
    fail,
    isClosed: () => closed,
    sleep,
  });
  return { dispatch, fail, sleep };
}

describe("createLocalDevScheduleDispatcher", () => {
  it("delivers once and reports nothing when delivery succeeds", async () => {
    const deliver = vi.fn(async () => {});
    const { dispatch, fail } = setup(deliver);
    await dispatch("claim");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });

  it("fails a permanent error such as a null auth result on the first attempt", async () => {
    const deliver = vi.fn(async () => {
      throw new PermanentScheduleMessageError("auth returned null");
    });
    const { dispatch, fail, sleep } = setup(deliver);
    await dispatch("claim");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("claim", "auth returned null", 1);
  });

  it("fails a persisted payload that does not parse on the first attempt", async () => {
    const deliver = vi.fn(async () => {
      parsePersistedSchedulePayload(
        { not: "a schedule payload" },
        { application: "app", collection: "wake" },
      );
    });
    const { dispatch, fail, sleep } = setup(deliver);
    await dispatch("claim");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      "claim",
      "Invalid scheduled collection payload; recreate the schedule.",
      1,
    );
  });

  it("fails a collection that is not deployed on the first attempt", async () => {
    const deliver = vi.fn(async () => {
      throw new ScheduleCollectionNotDeployedError("gone");
    });
    const { dispatch, fail } = setup(deliver);
    await dispatch("claim");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("retries other errors with growing delays, then fails after three attempts", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const { dispatch, fail, sleep } = setup(deliver);
    await dispatch("claim");
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [4_000]]);
    expect(fail).toHaveBeenCalledWith("claim", "model unavailable", 3);
  });

  it("stops quietly once the host has closed", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("closed mid-flight");
    });
    const { dispatch, fail } = setup(deliver, true);
    await dispatch("claim");
    expect(fail).not.toHaveBeenCalled();
  });
});

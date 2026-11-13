import { describe, expect, it } from "vitest";
import {
  averageBenchmarkImprovement,
  compareBenchmarkTasks,
} from "../dashboard/lib/benchmark-comparison";

describe("browser benchmark comparison", () => {
  it("reports positive improvement when the candidate is faster and cheaper", () => {
    expect(
      compareBenchmarkTasks(
        { costUsd: 2, durationMs: 10_000, id: "task", success: true },
        {
          costUsd: 1.5,
          durationMs: 8_000,
          id: "task",
          success: true,
        }
      )
    ).toEqual({ cost: -0.25, time: -0.2 });
  });

  it("averages paired per-test improvements", () => {
    expect(
      averageBenchmarkImprovement(
        [
          { costUsd: 2, durationMs: 10_000, id: "one", success: true },
          { costUsd: 1, durationMs: 20_000, id: "two", success: true },
        ],
        [
          { costUsd: 1, durationMs: 5_000, id: "one", success: true },
          { costUsd: 2, durationMs: 30_000, id: "two", success: true },
        ]
      )
    ).toEqual({ cost: 0.25, time: 0 });
  });

  it("excludes pairs unless both variants passed", () => {
    const baseline = {
      costUsd: 2,
      durationMs: 10_000,
      id: "task",
      success: true,
    };
    const candidate = {
      costUsd: 1,
      durationMs: 5_000,
      id: "task",
      success: false,
    };

    expect(compareBenchmarkTasks(baseline, candidate)).toEqual({
      cost: null,
      time: null,
    });
    expect(averageBenchmarkImprovement([baseline], [candidate])).toEqual({
      cost: null,
      time: null,
    });
  });
});

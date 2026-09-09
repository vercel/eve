import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputSchema as diffBenchInput } from "./diff_bench.ts";
import { inputSchema as getBenchResultInput } from "./get_bench_result.ts";
import { inputSchema as listBenchTasksInput } from "./list_bench_tasks.ts";
import { inputSchema as runBenchInput } from "./run_bench.ts";

describe("run_bench input", () => {
  it("accepts valid eve and oracle inputs", () => {
    assert.equal(
      runBenchInput.safeParse({
        cohort: "smoke",
        tasks: ["fix-git"],
        model: "zai/glm-5.2",
        harness: "eve",
        eve: "local",
        attempts: 2,
        concurrency: 1,
        job: "t1",
      }).success,
      true,
    );
    assert.equal(runBenchInput.safeParse({ harness: "oracle" }).success, true);
  });

  it("rejects invalid inputs", () => {
    assert.equal(runBenchInput.safeParse({}).success, false);
    assert.equal(runBenchInput.safeParse({ harness: "other", model: "model" }).success, false);
    assert.equal(runBenchInput.safeParse({ harness: "oracle", attempts: 0 }).success, false);
    assert.equal(runBenchInput.safeParse({ harness: "oracle", tasks: "fix-git" }).success, false);
  });
});

describe("get_bench_result input", () => {
  it("accepts a job name", () => {
    assert.equal(getBenchResultInput.safeParse({ job: "smoke-run" }).success, true);
  });

  it("rejects a missing or empty job name", () => {
    assert.equal(getBenchResultInput.safeParse({}).success, false);
    assert.equal(getBenchResultInput.safeParse({ job: "" }).success, false);
  });
});

describe("diff_bench input", () => {
  it("accepts base and candidate jobs", () => {
    assert.equal(
      diffBenchInput.safeParse({ base: "base-run", candidate: "candidate-run" }).success,
      true,
    );
  });

  it("rejects incomplete input", () => {
    assert.equal(diffBenchInput.safeParse({ base: "base-run" }).success, false);
    assert.equal(diffBenchInput.safeParse({ base: 1, candidate: "candidate-run" }).success, false);
  });
});

describe("list_bench_tasks input", () => {
  it("accepts empty, cohort, and dataset selections", () => {
    assert.equal(listBenchTasksInput.safeParse({}).success, true);
    assert.equal(listBenchTasksInput.safeParse({ cohort: "smoke" }).success, true);
    assert.equal(listBenchTasksInput.safeParse({ dataset: "terminal-bench-2.0" }).success, true);
  });

  it("rejects invalid selections", () => {
    assert.equal(listBenchTasksInput.safeParse({ cohort: "" }).success, false);
    assert.equal(listBenchTasksInput.safeParse({ dataset: ["terminal-bench-2.0"] }).success, false);
  });
});

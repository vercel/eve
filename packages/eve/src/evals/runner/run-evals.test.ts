import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { createEvalTargetHandle } from "#evals/target.js";
import type {
  AssertionResult,
  EveEval,
  EveEvalConfig,
  EveEvalResult,
  EveEvalTaskResult,
} from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import type { RunEvalsOptions } from "#evals/runner/run-evals.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

const mockedRunnerDependencies = vi.hoisted(() => ({
  executeTask: vi.fn(),
  resolveArtifactDirectory: vi.fn(),
  writeArtifacts: vi.fn(),
}));

vi.mock("./execute-task.js", () => ({
  executeTask: mockedRunnerDependencies.executeTask,
}));

vi.mock("./artifacts.js", () => ({
  resolveArtifactDirectory: mockedRunnerDependencies.resolveArtifactDirectory,
  writeArtifacts: mockedRunnerDependencies.writeArtifacts,
}));

import { runEvals } from "#evals/runner/run-evals.js";

const TEST_CONFIG: EveEvalConfig = {
  _tag: "EveEvalConfig",
  judge: { model: "openai/gpt-5.4-mini" },
};

/** The shape `executeTask` (mocked here) resolves to. */
type TaskOutcome = { result: EveEvalTaskResult; assertions: readonly AssertionResult[] };

/** Calls `runEvals` with the required config defaulted unless overridden. */
function run(options: Omit<RunEvalsOptions, "config"> & { config?: EveEvalConfig }) {
  return runEvals({ config: TEST_CONFIG, ...options });
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function createTaskResult(label: string): TaskOutcome {
  return {
    result: {
      output: label,
      finalMessage: label,
      status: "completed",
      events: [],
      derived: createEmptyDerivedFacts(),
    },
    assertions: [],
  };
}

function createEval(id: string, overrides: Partial<EveEval> = {}): EveEval {
  return {
    _tag: "EveEval",
    id,
    test: async () => {},
    ...overrides,
  } as EveEval;
}

function mockArtifacts(): void {
  mockedRunnerDependencies.resolveArtifactDirectory.mockReturnValue("/tmp/eve-evals");
  mockedRunnerDependencies.writeArtifacts.mockResolvedValue(undefined);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// `executeTask` is mocked in these tests, so the client never reaches the
// network. We pass a real `Client` instance to satisfy the type without
// adding a duplicate interface.
const unusedClient = new Client({ host: "http://localhost" });

const localTarget = createEvalTargetHandle({
  capabilities: { devRoutes: true },
  client: unusedClient,
  kind: "local",
  url: "http://localhost",
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("runEvals", () => {
  it("runs up to eight evals in parallel when maxConcurrency is omitted", async () => {
    const deferreds = new Map<string, Deferred<TaskOutcome>>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;

    const evaluations = Array.from({ length: 9 }, (_, index) => {
      const id = `eval-${index + 1}`;
      deferreds.set(id, createDeferred<TaskOutcome>());
      return createEval(id);
    });

    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockImplementation(
      async ({ evaluation }: { evaluation: EveEval }) => {
        started.push(evaluation.id);
        active += 1;
        peak = Math.max(peak, active);

        const deferred = deferreds.get(evaluation.id);
        if (deferred === undefined) {
          throw new Error(`Missing deferred result for ${evaluation.id}`);
        }

        return deferred.promise.finally(() => {
          active -= 1;
        });
      },
    );

    const runPromise = run({
      evaluations,
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
    });

    await flushMicrotasks();

    expect(started).toHaveLength(8);
    expect(peak).toBe(8);

    deferreds.get("eval-1")?.resolve(createTaskResult("eval-1"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toHaveLength(9);
    expect(peak).toBe(8);

    for (const evaluation of evaluations.slice(1)) {
      const deferred = deferreds.get(evaluation.id);
      if (deferred === undefined) {
        throw new Error(`Missing deferred result for ${evaluation.id}`);
      }

      deferred.resolve(createTaskResult(evaluation.id));
    }

    const summary = await runPromise;

    expect(summary.results).toHaveLength(9);
    expect(summary.passed).toBe(9);
    expect(summary.failed).toBe(0);
    expect(summary.scored).toBe(0);
    expect(summary.errored).toBe(0);
  });

  it("rejects a non-positive or non-integer maxConcurrency instead of spinning", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    for (const maxConcurrency of [0, -1, Number.NaN, 1.5]) {
      await expect(
        run({
          evaluations: [createEval("one")],
          target: localTarget,
          client: unusedClient,
          appRoot: "/tmp/app",
          reporters: [],
          maxConcurrency,
        }),
      ).rejects.toThrow(/maxConcurrency must be a positive integer/);
    }

    expect(mockedRunnerDependencies.executeTask).not.toHaveBeenCalled();
  });

  it("respects an explicit maxConcurrency", async () => {
    let active = 0;
    let peak = 0;

    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return createTaskResult("done");
    });

    const evaluations = Array.from({ length: 5 }, (_, index) => createEval(`eval-${index + 1}`));

    await run({
      evaluations,
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
      maxConcurrency: 1,
    });

    expect(peak).toBe(1);
  });

  it("reports results in discovery order regardless of completion order", async () => {
    const first = createDeferred<TaskOutcome>();
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockImplementation(
      async ({ evaluation }: { evaluation: EveEval }) => {
        if (evaluation.id === "a-first") return first.promise;
        return createTaskResult(evaluation.id);
      },
    );

    const runPromise = run({
      evaluations: [createEval("a-first"), createEval("b-second")],
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    first.resolve(createTaskResult("a-first"));

    const summary = await runPromise;
    expect(summary.results.map((result) => result.id)).toEqual(["a-first", "b-second"]);
  });

  it("drives run-level reporters across every eval", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    const seen: string[] = [];
    const reporter: EvalReporter = {
      onRunStart: (evaluations) => {
        seen.push(`start:${evaluations.map((e) => e.id).join(",")}`);
      },
      onEvalComplete: (result: EveEvalResult) => {
        seen.push(`eval:${result.id}`);
      },
      onRunComplete: (summary) => {
        seen.push(`complete:${summary.results.length}`);
      },
    };

    await run({
      evaluations: [createEval("one"), createEval("two")],
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [reporter],
      maxConcurrency: 1,
    });

    expect(seen).toEqual(["start:one,two", "eval:one", "eval:two", "complete:2"]);
  });

  it("scopes eval-defined reporters to the evals referencing them", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    const seen: string[] = [];
    const scopedReporter: EvalReporter = {
      onRunStart: (evaluations) => {
        seen.push(`start:${evaluations.map((e) => e.id).join(",")}`);
      },
      onEvalComplete: (result) => {
        seen.push(`eval:${result.id}`);
      },
      onRunComplete: (summary) => {
        seen.push(`complete:${summary.results.map((r) => r.id).join(",")}`);
      },
    };

    // The same reporter instance shared by two evals dedupes into one binding.
    await run({
      evaluations: [
        createEval("one", { reporters: [scopedReporter] }),
        createEval("two", { reporters: [scopedReporter] }),
        createEval("three"),
      ],
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
      maxConcurrency: 1,
    });

    expect(seen).toEqual(["start:one,two", "eval:one", "eval:two", "complete:one,two"]);
  });

  it("ignores eval-defined reporters when includeEvalReporters is false", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    const onRunStart = vi.fn();
    const scopedReporter: EvalReporter = {
      onRunStart,
      onEvalComplete: () => undefined,
      onRunComplete: () => undefined,
    };

    await run({
      evaluations: [createEval("one", { reporters: [scopedReporter] })],
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
      includeEvalReporters: false,
    });

    expect(onRunStart).not.toHaveBeenCalled();
  });

  it("falls back to the config judge model for evals without their own", async () => {
    mockArtifacts();
    const seen: Array<string | undefined> = [];
    mockedRunnerDependencies.executeTask.mockImplementation(
      async ({ evaluation }: { evaluation: EveEval }) => {
        seen.push(evaluation.judge === undefined ? undefined : String(evaluation.judge.model));
        return createTaskResult(evaluation.id);
      },
    );

    await run({
      evaluations: [
        createEval("uses-config"),
        createEval("overrides", { judge: { model: "openai/gpt-5.4-override" } }),
      ],
      config: { _tag: "EveEvalConfig", judge: { model: "openai/gpt-5.4-mini" } },
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
      maxConcurrency: 1,
    });

    expect(seen).toEqual(["openai/gpt-5.4-mini", "openai/gpt-5.4-override"]);
  });

  it("uses config maxConcurrency when no CLI override is set", async () => {
    let active = 0;
    let peak = 0;
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return createTaskResult("done");
    });

    await run({
      evaluations: Array.from({ length: 5 }, (_, index) => createEval(`eval-${index + 1}`)),
      config: { _tag: "EveEvalConfig", judge: { model: "openai/gpt-5.4-mini" }, maxConcurrency: 2 },
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
    });

    expect(peak).toBe(2);
  });

  it("drives config reporters across every eval and dedupes eval references", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    const seen: string[] = [];
    const configReporter: EvalReporter = {
      onRunStart: (evaluations) => {
        seen.push(`start:${evaluations.map((e) => e.id).join(",")}`);
      },
      onEvalComplete: (result) => {
        seen.push(`eval:${result.id}`);
      },
      onRunComplete: (summary) => {
        seen.push(`complete:${summary.results.length}`);
      },
    };

    // The config reporter observes every eval; referencing it from an eval too
    // must not double-fire its callbacks.
    await run({
      evaluations: [createEval("one", { reporters: [configReporter] }), createEval("two")],
      config: {
        _tag: "EveEvalConfig",
        judge: { model: "openai/gpt-5.4-mini" },
        reporters: [configReporter],
      },
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
      maxConcurrency: 1,
    });

    expect(seen).toEqual(["start:one,two", "eval:one", "eval:two", "complete:2"]);
  });

  it("writes run artifacts once with the aggregated summary", async () => {
    mockArtifacts();
    mockedRunnerDependencies.executeTask.mockResolvedValue(createTaskResult("done"));

    const summary = await run({
      evaluations: [createEval("one")],
      target: localTarget,
      client: unusedClient,
      appRoot: "/tmp/app",
      reporters: [],
    });

    expect(mockedRunnerDependencies.resolveArtifactDirectory).toHaveBeenCalledWith("/tmp/app");
    expect(mockedRunnerDependencies.writeArtifacts).toHaveBeenCalledWith("/tmp/eve-evals", summary);
  });
});

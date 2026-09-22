import { describe, expect, it } from "vitest";

// @ts-expect-error Vendoring configs are executable JavaScript without declarations.
import workflowCoreVendor from "../scripts/vendor-compiled/@workflow/core.mjs";

const beta55NodeCallSite = `
const executed = s.lazyStepInput === undefined &&
    s.preclaimedStart === undefined
    ? runStepSingleFlight(runId, s.correlationId, run)
    : run();
return executed;
`;

type StepResult = { type: "completed" | "skipped" };

type VendorPlugin = {
  name: string;
  transform?: (source: string, id: string) => { code: string } | null | undefined;
};

const inlineStepPlugin = (workflowCoreVendor as { plugins: VendorPlugin[] }).plugins.find(
  (plugin) => plugin.name === "eve:guard-inline-step-execution",
);

function transformInlineStepExecution(source: string) {
  const transformed = inlineStepPlugin?.transform?.(
    source,
    "/workspace/node_modules/@workflow/core/dist/runtime.js",
  );
  if (!transformed) throw new Error("Failed to transform the inline step call site.");
  return transformed.code;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSingleFlight() {
  const inFlight = new Map<string, Promise<StepResult>>();
  const logLevels: string[] = [];

  return {
    logLevels,
    async run(
      runId: string,
      correlationId: string,
      execute: () => Promise<StepResult>,
      logLevel: string,
    ): Promise<StepResult> {
      const key = `${runId}:${correlationId}`;
      const existing = inFlight.get(key);
      if (existing) {
        logLevels.push(logLevel);
        await existing;
        return { type: "skipped" };
      }

      const execution = execute();
      inFlight.set(key, execution);
      try {
        return await execution;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

const executeInlineStep = new Function(
  "runStepSingleFlight",
  "runId",
  "s",
  "run",
  transformInlineStepExecution(beta55NodeCallSite),
) as (
  runStepSingleFlight: ReturnType<typeof createSingleFlight>["run"],
  runId: string,
  s: {
    correlationId: string;
    lazyStepInput?: unknown;
    preclaimedStart?: { owned: boolean };
  },
  run: () => Promise<StepResult>,
) => Promise<StepResult>;

describe("inline step single-flight vendoring patch", () => {
  it("bypasses only rejected preclaims and retains contention log levels", async () => {
    const transformed = transformInlineStepExecution(beta55NodeCallSite);
    const logLevels: string[] = [];
    let directExecutions = 0;
    const runStepSingleFlight = async (
      _runId: string,
      _correlationId: string,
      run: () => Promise<StepResult>,
      logLevel: string,
    ) => {
      logLevels.push(logLevel);
      return run();
    };
    const run = async () => {
      directExecutions += 1;
      return { type: "completed" } as const;
    };

    await executeInlineStep(
      runStepSingleFlight,
      "run",
      {
        correlationId: "rejected",
        preclaimedStart: { owned: false },
      },
      run,
    );
    await executeInlineStep(
      runStepSingleFlight,
      "run",
      {
        correlationId: "owned",
        preclaimedStart: { owned: true },
      },
      run,
    );
    await executeInlineStep(
      runStepSingleFlight,
      "run",
      {
        correlationId: "lazy",
        lazyStepInput: {},
      },
      run,
    );
    await executeInlineStep(runStepSingleFlight, "run", { correlationId: "recovery" }, run);

    expect(transformed).toContain("s.preclaimedStart?.owned === false");
    expect(directExecutions).toBe(4);
    expect(logLevels).toEqual(["debug", "debug", "warn"]);
  });

  it("runs the preclaim owner when a rejected preclaim enters first", async () => {
    const singleFlight = createSingleFlight();
    const loserEntered = deferred();
    const ownerRan = deferred();
    const releaseLoser = deferred();
    let executions = 0;

    const loser = executeInlineStep(
      singleFlight.run,
      "run",
      { correlationId: "step", preclaimedStart: { owned: false } },
      async () => {
        loserEntered.resolve();
        await releaseLoser.promise;
        return { type: "skipped" };
      },
    );
    await loserEntered.promise;

    const owner = executeInlineStep(
      singleFlight.run,
      "run",
      { correlationId: "step", preclaimedStart: { owned: true } },
      async () => {
        executions += 1;
        ownerRan.resolve();
        return { type: "completed" };
      },
    );
    await ownerRan.promise;

    releaseLoser.resolve();
    await expect(owner).resolves.toEqual({ type: "completed" });
    await expect(loser).resolves.toEqual({ type: "skipped" });
    expect(executions).toBe(1);
    expect(singleFlight.logLevels).toEqual([]);
  });
});

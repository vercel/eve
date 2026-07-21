import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const TUNING_EVAL =
  'export default { _tag: "EveEval", description: "tuning case", test: async () => {} };\n';
const HELD_OUT_EVAL =
  'export default { _tag: "EveEval", description: "held-out case", test: async () => {} };\n';

/**
 * A module that throws at initialization stands in for any held-out or tuning
 * module with import-time side effects. Loading it during the opposite
 * partition's discovery would surface here as a thrown error, so a clean
 * `--list` proves the module was never imported.
 */
const THROWING_MODULE = 'throw new Error("OPPOSITE_PARTITION_IMPORTED_DURING_DISCOVERY");\n';

afterEach(() => {
  process.exitCode = undefined;
});

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return logger.log.mock.calls.map(([message]) => String(message)).join("\n");
}

describe("eve eval partition isolation (real CLI)", () => {
  it("lists only tuning evals without importing a throwing held-out module", async () => {
    const { appRoot } = await createAppRoot("eve-eval-partition-cli-", {
      files: {
        "evals/tuning/alpha.eval.ts": TUNING_EVAL,
        "evals/held-out/secret.eval.ts": THROWING_MODULE,
      },
    });
    const logger = { error: vi.fn(), log: vi.fn() };
    const previousCwd = process.cwd();

    process.chdir(appRoot);
    try {
      await runCli(["eval", "tuning", "--list"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(getLogOutput(logger)).toContain("tuning/alpha");
    expect(getLogOutput(logger)).not.toContain("held-out");
  });

  it("lists only held-out evals without importing a throwing tuning module", async () => {
    const { appRoot } = await createAppRoot("eve-eval-partition-cli-", {
      files: {
        "evals/tuning/loud.eval.ts": THROWING_MODULE,
        "evals/held-out/secret.eval.ts": HELD_OUT_EVAL,
      },
    });
    const logger = { error: vi.fn(), log: vi.fn() };
    const previousCwd = process.cwd();

    process.chdir(appRoot);
    try {
      await runCli(["eval", "held-out", "--list"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(getLogOutput(logger)).toContain("held-out/secret");
    expect(getLogOutput(logger)).not.toContain("tuning");
  });
});

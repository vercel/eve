import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { resolveApplicationRoot } from "#internal/application/paths.js";
import { createDevelopmentServer, type DevelopmentServer } from "#internal/nitro/host.js";
import { createEvalClient } from "#evals/cli/eval-client.js";
import {
  discoverAndImportEvals,
  discoverEvalConfig,
  findMisplacedEvalDirs,
} from "#evals/runner/discover.js";
import { runEvals } from "#evals/runner/run-evals.js";
import { ConsoleReporter } from "#evals/runner/reporters/console.js";
import { JUnit } from "#evals/runner/reporters/junit.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import { resolveEvalTargetHandle } from "#evals/target.js";
import type { EveEval, EveEvalTargetHandle } from "#evals/types.js";

interface EvalCliOptions {
  url?: string;
  timeout?: string;
  maxConcurrency?: string;
  json?: boolean;
  junit?: string;
  skipReport?: boolean;
  strict?: boolean;
  list?: boolean;
  tag?: string[];
  verbose?: boolean;
}

type EvalCliLogger = { log(message: string): void; error(message: string): void };

/**
 * Runs the `eve eval` command with already-parsed Commander options.
 *
 * Exit codes: `0` when every executed eval passed its gate assertions (and
 * soft thresholds under `--strict`), `1` when any eval failed, `2` for runner
 * or configuration errors (no evals discovered, no evals matching filters).
 */
export async function runEvalCommand(
  evalIds: readonly string[],
  options: EvalCliOptions,
  logger: EvalCliLogger,
): Promise<void> {
  const appRoot = resolveApplicationRoot();

  loadDevelopmentEnvironmentFiles(appRoot);

  const requestedEvalIds = evalIds.length > 0 ? evalIds : undefined;
  const discovered = await discoverAndImportEvals(appRoot, requestedEvalIds);

  if (discovered.length === 0) {
    const misplaced = await findMisplacedEvalDirs(appRoot);
    if (misplaced.length > 0) {
      logger.error(
        "No evals found under evals/, but eval files are present inside agent/:\n" +
          misplaced.map((dir) => `  - ${dir}`).join("\n") +
          "\neve eval only scans the top-level evals/ directory (a sibling of agent/). " +
          "Move these files there.",
      );
    } else if (requestedEvalIds) {
      logger.error(`No evals found matching: ${requestedEvalIds.join(", ")}`);
    } else {
      logger.error("No evals found. Create files under evals/ with the *.eval.ts extension.");
    }
    process.exitCode = 2;
    return;
  }

  const evaluations = filterEvalsByTag(discovered, options.tag ?? []);
  if (evaluations.length === 0) {
    logger.error(`No evals matched the provided tags (${(options.tag ?? []).join(", ")}).`);
    process.exitCode = 2;
    return;
  }

  let maxConcurrency: number | undefined;
  let timeoutMs: number | undefined;
  try {
    maxConcurrency = parsePositiveInteger(options.maxConcurrency, "--max-concurrency");
    timeoutMs = parseNonNegativeInteger(options.timeout, "--timeout");
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  if (options.list === true) {
    printEvalList(evaluations, options.json === true, logger);
    return;
  }

  let config;
  try {
    config = await discoverEvalConfig(appRoot);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  // Resolve target
  let devServer: DevelopmentServer | undefined;
  let target: EveEvalTargetHandle;
  let client: Awaited<ReturnType<typeof createEvalClient>>;

  try {
    if (options.url) {
      client = await createEvalClient(
        { kind: "remote", url: options.url },
        { workspaceRoot: appRoot },
      );
      target = await resolveEvalTargetHandle({
        client,
        expectedAgentName: await readExpectedAgentName(appRoot),
        kind: "remote",
        url: options.url,
      });
    } else {
      devServer = createDevelopmentServer(appRoot, { host: "127.0.0.1", port: 0 });
      const started = await devServer.start();
      client = await createEvalClient({ kind: "local", url: started.url });
      target = await resolveEvalTargetHandle({
        client,
        expectedAgentName: await readExpectedAgentName(appRoot),
        kind: "local",
        url: started.url,
      });
    }

    const reporters: EvalReporter[] = options.json === true ? [] : [new ConsoleReporter()];
    if (options.junit !== undefined) {
      reporters.push(JUnit({ filePath: options.junit }));
    }

    const summary = await runEvals({
      evaluations,
      config,
      target,
      client,
      appRoot,
      reporters,
      includeEvalReporters: options.skipReport !== true,
      maxConcurrency,
      timeoutMs,
      onEvalLog:
        options.verbose === true
          ? (evalId, message) => logger.log(`[${evalId}] ${message}`)
          : undefined,
    });

    if (options.json) {
      logger.log(JSON.stringify(summary, null, 2));
    }

    // Check failures (which include execution errors) always fail the exit
    // code. Low scores are soft data unless --strict turns threshold misses
    // into failures.
    const hasFailures = summary.failed > 0;
    const hasStrictMisses = options.strict === true && summary.scored > 0;
    if (hasFailures || hasStrictMisses) {
      process.exitCode = 1;
    }
  } finally {
    if (devServer) {
      await devServer.close();
      await shutdownActiveSandboxHandles({
        log: (message) => logger.error(message),
      });
    }
  }

  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

/** Parses an integer CLI option that must be >= 1 (e.g. `--max-concurrency`). */
function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer; got "${value}".`);
  }
  return parsed;
}

/** Parses an integer CLI option that must be >= 0 (e.g. `--timeout`). */
function parseNonNegativeInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer; got "${value}".`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Eval filtering
// ---------------------------------------------------------------------------

/** Applies `--tag` filtering: an eval runs when it carries any requested tag. */
function filterEvalsByTag(evaluations: readonly EveEval[], tags: readonly string[]): EveEval[] {
  if (tags.length === 0) return [...evaluations];
  return evaluations.filter(
    (evaluation) => evaluation.tags?.some((tag) => tags.includes(tag)) ?? false,
  );
}

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

function printEvalList(
  evaluations: readonly EveEval[],
  json: boolean,
  logger: EvalCliLogger,
): void {
  if (json) {
    const listing = evaluations.map((evaluation) => ({
      id: evaluation.id,
      description: evaluation.description,
      tags: evaluation.tags,
    }));
    logger.log(JSON.stringify(listing, null, 2));
    return;
  }

  for (const evaluation of evaluations) {
    const description = evaluation.description === undefined ? "" : ` — ${evaluation.description}`;
    const tags =
      evaluation.tags !== undefined && evaluation.tags.length > 0
        ? ` [${evaluation.tags.join(", ")}]`
        : "";
    logger.log(`${evaluation.id}${tags}${description}`);
  }
}

async function readExpectedAgentName(appRoot: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
      readonly name?: unknown;
    };
    return typeof packageJson.name === "string" && packageJson.name.length > 0
      ? packageJson.name
      : basename(appRoot);
  } catch {
    return basename(appRoot);
  }
}

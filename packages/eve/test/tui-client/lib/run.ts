import {
  createLocalTestEnvironment,
  type LocalTestEnvironment,
  type LocalTestTargetRequest,
  type TestTarget,
} from "../target.ts";
import { startAgentServer } from "./server.ts";
import { printErrorChain } from "./stream.ts";
import { theme } from "./theme.ts";

export type RunOptions = LocalTestTargetRequest;

export type RunCallback = (target: TestTarget) => Promise<void>;

export type RunCleanup = () => Promise<void> | void;

export interface RunEnvironmentContext {
  readonly environment: LocalTestEnvironment;

  target(input: LocalTestTargetRequest): Promise<TestTarget>;
  cleanup(cleanup: RunCleanup): void;
}

export function run(opts: RunOptions, fn: RunCallback): void {
  runEnvironment("smoke test", async ({ target }) => {
    await fn(await target(opts));
  });
}

export function runEnvironment(
  name: string,
  fn: (context: RunEnvironmentContext) => Promise<void>,
): void {
  void (async () => {
    const environment = createLocalTestEnvironment({ startServer: startAgentServer });
    const cleanups: RunCleanup[] = [];
    let stopPromise: Promise<void> | undefined;

    const stopAll = async () => {
      if (stopPromise !== undefined) return stopPromise;

      stopPromise = (async () => {
        const results = await Promise.allSettled([
          environment.stop(),
          ...cleanups.toReversed().map((cleanup) => cleanup()),
        ]);
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, `${name} cleanup failed with multiple errors.`);
        }
      })();

      return stopPromise;
    };

    const onSignal = (signal: NodeJS.Signals) => {
      console.log(theme.muted(`\n[tui] received ${signal}, shutting down...`));
      void stopAll()
        .catch((error: unknown) => {
          console.error(theme.danger("\n[tui] smoke test cleanup failed:"), error);
          printErrorChain(error);
        })
        .finally(() => process.exit(130));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    let cleanupError: unknown;
    let runError: unknown;
    try {
      await fn({
        environment,
        target: (input) => environment.target(input),
        cleanup: (cleanup) => cleanups.push(cleanup),
      });
    } catch (error) {
      runError = error;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        await stopAll();
      } catch (error) {
        cleanupError = error;
      }
    }

    if (runError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([runError, cleanupError], `${name} failed and cleanup also failed.`);
    }

    if (runError !== undefined) {
      throw runError;
    }

    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  })().catch((error) => {
    console.error(theme.danger(`\n[tui] ${name} failed:`), error);
    printErrorChain(error);
    process.exitCode = 1;
  });
}

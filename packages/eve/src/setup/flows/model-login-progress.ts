import type { Prompter } from "#setup/prompter.js";
import { withSpinner } from "#setup/with-spinner.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("setup.model-login");

type LoginStage = "source_inspection" | "gateway_catalog" | "authentication" | "activation";

/** Fixed stage names and durations only: no credentials, team names, or provider responses. */
export async function measureLoginStage<T>(stage: LoginStage, task: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await task();
  } finally {
    log.debug(stage, { elapsedMs: Math.round(performance.now() - started) });
  }
}

/** Avoid painting a loading phase for quick local work. */
export function withLoginProgress<T>(
  prompter: Prompter,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  return withSpinner(prompter, message, task, 150);
}

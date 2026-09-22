import type { Prompter } from "./prompter.js";

/** Runs asynchronous work behind an optional spinner that always stops. */
export async function withSpinner<T>(
  prompter: Prompter,
  message: string,
  task: () => Promise<T>,
  delayMs = 0,
): Promise<T> {
  let spinner: ReturnType<NonNullable<Prompter["log"]["spinner"]>> | undefined;
  const start = () => {
    spinner = prompter.log.spinner?.(message);
  };
  const timer = delayMs > 0 ? setTimeout(start, delayMs) : undefined;
  if (timer === undefined) start();
  try {
    return await task();
  } finally {
    clearTimeout(timer);
    spinner?.stop();
  }
}

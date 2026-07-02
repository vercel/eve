import type { Prompter } from "./prompter.js";

/** Runs asynchronous work behind an optional spinner that always stops. */
export async function withSpinner<T>(
  prompter: Prompter,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  const spinner = prompter.log.spinner?.(message);
  try {
    return await task();
  } finally {
    spinner?.stop();
  }
}

import { isRunTargetGone } from "#shared/run-errors.js";

/** Awaits traffic to a hook or run, which a target already gone makes moot. */
export async function ignoreGoneTarget(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!isRunTargetGone(error)) throw error;
  }
}

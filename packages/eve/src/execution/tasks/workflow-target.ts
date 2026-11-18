import { isRunTargetGone } from "#shared/run-errors.js";

export async function ignoreGoneTarget(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!isRunTargetGone(error)) throw error;
  }
}

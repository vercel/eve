import { isRunTargetGone } from "#shared/run-errors.js";
import { resumeRoutedHook } from "#execution/hosts.js";

/** Resumes a hook wherever it's held. With `ifPresent`, a hook that's gone is ignored. */
export async function resumeHookWherever(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  try {
    await resumeRoutedHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isRunTargetGone(error)) return;
    throw error;
  }
}

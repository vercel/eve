import { isRunTargetGone } from "#shared/run-errors.js";
import { resumeRoutedHook } from "#execution/hosts.js";

export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  try {
    await resumeRoutedHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isRunTargetGone(error)) return;
    throw error;
  }
}

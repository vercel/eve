import { isRunTargetGone } from "#shared/run-errors.js";
import { resumeRoutedHook, type RouteHosts } from "#execution/hosts.js";

export async function resumeHookWherever(
  hosts: RouteHosts,
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  try {
    await resumeRoutedHook(hosts, token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isRunTargetGone(error)) return;
    throw error;
  }
}

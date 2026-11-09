/**
 * Hook operations for routes and functions marked with `"use step"`.
 *
 * Run operations (`start`, `getRun`) live in `eve/experimental/workflow/api`.
 */
import * as runtime from "#internal/workflow/runtime.js";

/** Delivers a payload to the hook with this token; resolves once the payload is persisted. */
// The SDK also accepts hook records and key overrides and resolves the storage record; eve keeps
// tokens as the only handle and does not promise that record.
export async function resumeHook<T = unknown>(token: string, payload: T): Promise<void> {
  await runtime.resumeHook(token, payload);
}

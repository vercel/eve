/**
 * Internal marker for framework tool definitions whose behavior is supplied
 * by the harness or a provider rather than a module executor: `ask_question`
 * (client-side input request), `agent`, `task_update`, `task_cancel`
 * (runtime-dispatch actions), and `web_search` (provider-managed).
 *
 * The marker is public-shaped data on an ordinary tool definition value —
 * the constructor stays unexported so applications cannot mint execute-less
 * tools. Kernel-effect declarations replace this marker when dispatch moves
 * behind typed effects.
 */
const HARNESS_OWNED_TOOL_BRAND = Symbol.for("eve.harness-owned-tool");

/**
 * Marks one internally constructed, execute-less tool definition as
 * harness-owned so normalization accepts it without an executor.
 */
export function markHarnessOwnedToolDefinition<T extends object>(definition: T): T {
  Object.assign(definition, { [HARNESS_OWNED_TOOL_BRAND]: true });
  return definition;
}

/** Whether one authored export is a harness-owned execute-less definition. */
export function isHarnessOwnedToolDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[HARNESS_OWNED_TOOL_BRAND] === true
  );
}

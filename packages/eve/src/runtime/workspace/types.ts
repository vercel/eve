/**
 * The default sandbox workspace root, used by every built-in provider and by
 * a connection that does not declare its own `workspaceRoot`.
 */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Runtime-facing workspace summary rendered into the prompt.
 *
 * Carries only the lexicographically sorted root entries visible at the
 * live workspace cwd. Seed file bytes do not flow through this type.
 */
export interface WorkspaceRuntimeSpec {
  readonly rootEntries: readonly string[];
}

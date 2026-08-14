/**
 * Stable root directory for every workspace eve exposes to agents and
 * sandbox backends.
 *
 * This is both the model-facing logical path and the live `bash` cwd
 * for every backend. Backends must initialize their filesystems so
 * commands run at this path; there is no per-backend translation.
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

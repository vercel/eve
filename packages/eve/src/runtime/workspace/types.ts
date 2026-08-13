import { createHash } from "node:crypto";

/**
 * Stable root directory for every workspace eve exposes to agents and
 * sandbox backends.
 *
 * This is both the model-facing logical path and the live `bash` cwd
 * for every backend — including subagents sharing a parent's sandbox.
 * Sharing the working tree is the point of sharing a sandbox: a child
 * dispatched to work on the parent's files sees them at the same paths
 * the parent does. Backends must initialize their filesystems so
 * commands run at this path; there is no per-backend translation.
 */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Root directory that holds one home directory per subagent sharing a
 * parent sandbox.
 *
 * The working tree is shared; homes are private. Classic unix
 * multi-tenancy — collaborators share the project directory while each
 * principal keeps its own `$HOME` for dotfiles, caches, and skills:
 *
 *   /workspace                      ← shared working tree, every agent's cwd
 *   /agents/{slug}/.agents/skills   ← per-agent skill store ($HOME/.agents/skills)
 *
 * The scoped sandbox session sets `HOME=/agents/{slug}` for the agent,
 * so home-relative conventions ("$HOME/.agents/skills", `~/.gitconfig`)
 * resolve per agent with no path encoding. When per-agent Linux users
 * arrive, this layout maps directly onto `/home/{user}`.
 */
export const AGENT_HOMES_ROOT = "/agents";

/**
 * Derives the home directory name for one runtime node.
 *
 * Human-readable leaf plus a short content hash of the full node id:
 * `subagents/researcher` → `researcher-1c3a9f42`. The hash suffix keeps
 * slugs unique across arbitrary node ids; the sanitized leaf keeps
 * `ls /agents` readable. No shell-hostile characters are produced.
 */
export function agentHomeSlug(nodeId: string): string {
  const leaf = nodeId.split("/").at(-1) ?? nodeId;
  const sanitized = leaf.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "-");
  const hash = createHash("sha256").update(nodeId).digest("hex").slice(0, 8);
  return `${sanitized}-${hash}`;
}

/** Returns the agent home directory for one runtime node. */
export function resolveAgentHome(nodeId: string): string {
  return `${AGENT_HOMES_ROOT}/${agentHomeSlug(nodeId)}`;
}

/**
 * Runtime-facing workspace summary rendered into the prompt.
 *
 * Carries only the lexicographically sorted root entries visible at the
 * live workspace cwd. Seed file bytes do not flow through this type.
 */
export interface WorkspaceRuntimeSpec {
  readonly rootEntries: readonly string[];
}

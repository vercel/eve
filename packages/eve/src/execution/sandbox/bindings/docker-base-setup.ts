import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

/**
 * One-time setup applied to containers created from the raw base image
 * (template builds and template-less sessions). Keeps the framework-owned
 * base layer deliberately tiny: create `/workspace` and verify Bash,
 * because the sandbox `bash` tool and command execution depend on it.
 */
export function buildDockerBaseSetupScript(): string {
  return [
    "set -e",
    `mkdir -p ${WORKSPACE_ROOT}`,
    'command -v bash >/dev/null 2>&1 || { echo "the sandbox image must provide bash" >&2; exit 70; }',
  ].join("\n");
}

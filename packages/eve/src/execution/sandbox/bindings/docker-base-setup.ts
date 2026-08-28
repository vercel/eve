import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

/**
 * Base setup applied to containers created from the raw base image and to
 * Vercel sessions when they are attached. Keeps the framework-owned
 * base layer deliberately tiny: create `/workspace`, verify Bash, and provide
 * the standard file-descriptor path that Bash process substitution requires.
 */
export function buildDockerBaseSetupScript(): string {
  return [
    "set -e",
    `mkdir -p ${WORKSPACE_ROOT}`,
    'command -v bash >/dev/null 2>&1 || { echo "the sandbox image must provide bash" >&2; exit 70; }',
    "if [ ! /dev/fd -ef /proc/self/fd ]; then",
    '  [ ! -e /dev/fd ] || { echo "the sandbox runtime must expose open descriptors through /dev/fd" >&2; exit 70; }',
    '  [ -d /proc/self/fd ] || { echo "the sandbox runtime must provide /proc/self/fd" >&2; exit 70; }',
    "  ln -s /proc/self/fd /dev/fd 2>/dev/null || [ /dev/fd -ef /proc/self/fd ]",
    "fi",
    'test /dev/fd -ef /proc/self/fd || { echo "the sandbox runtime must expose open descriptors through /dev/fd" >&2; exit 70; }',
  ].join("\n");
}

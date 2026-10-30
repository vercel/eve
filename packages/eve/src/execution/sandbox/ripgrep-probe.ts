import type { SandboxSession } from "#public/definitions/sandbox.js";

// Searching an empty file checks that `rg` accepts eve's options (just-bash's
// `rg` does not) without walking a directory tree.
const RIPGREP_PROBE_COMMAND =
  "command -v rg >/dev/null 2>&1 || exit 127; " +
  "rg --line-number --color=never --hidden --glob '!.git/*' --max-count 1 -- " +
  "'__eve_ripgrep_probe_never_matches__' /dev/null";

export async function ripgrepIsAvailable(session: SandboxSession): Promise<boolean> {
  try {
    const result = await session.run({ command: RIPGREP_PROBE_COMMAND });
    return (result.exitCode === 0 || result.exitCode === 1) && result.stderr.trim().length === 0;
  } catch {
    return false;
  }
}

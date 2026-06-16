import type { SandboxSession } from "#public/definitions/sandbox.js";

/**
 * Memoizes the result of probing for `rg` (ripgrep) once per sandbox
 * session. The probe runs exactly one `command -v rg` per distinct
 * session object, regardless of how many grep/glob tool calls happen.
 */
const probes = new Map<string, Promise<boolean>>();

/**
 * Returns `true` when `rg` is on PATH in the given sandbox session,
 * `false` otherwise. Result is cached per session.
 *
 * Framework `grep` and `glob` tools call this to decide whether to use
 * ripgrep or the POSIX `grep`/`find` fallback.
 */
export async function ripgrepIsAvailable(session: SandboxSession): Promise<boolean> {
  const existing = probes.get(session.id);
  if (existing !== undefined) {
    return existing;
  }

  const pending = runProbe(session);
  probes.set(session.id, pending);

  try {
    return await pending;
  } catch {
    // If the probe itself threw, treat rg as unavailable and clear the
    // cache so a later call can retry. A failed probe usually means the
    // sandbox session is in a bad state; letting the next call retry is
    // safer than permanently marking rg as missing.
    probes.delete(session.id);
    return false;
  }
}

async function runProbe(session: SandboxSession): Promise<boolean> {
  const result = await session.run({ command: "command -v rg >/dev/null 2>&1" });
  return result.exitCode === 0;
}

import { tmpdir } from "node:os";
import { join } from "node:path";

import { codeSandbox } from "#runtime/sandbox/code-sandbox.js";
import { type CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
import { HostSandbox, type HostSandboxOptions } from "#sandbox/providers/host.js";

/**
 * The host directory as a code agent's sandbox (`HostSandbox`): commands run in `root()`, the
 * process's working directory by default, read each step. With `confine`, file tools and working
 * directories can't leave it. Its cache stays out of that directory. No isolation: gate `bash`
 * and `write_file` with approvals.
 */
export function hostSandbox(options: HostSandboxOptions = {}): CodeSandbox {
  return codeSandbox(HostSandbox.environment(options), {
    appRoot: join(tmpdir(), "eve-host-sandbox"),
    revision: "code:host",
  });
}

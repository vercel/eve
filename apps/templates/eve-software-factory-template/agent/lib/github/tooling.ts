import { createHash } from "node:crypto";
import type { VercelSandboxSession } from "eve/sandbox/vercel";

// GitHub API tools stay in the runtime. No gh wrappers or credential leases
// are installed in the stations that execute repository-controlled code.
const INSTALL_SCRIPT = [
  "set -e",
  "command -v git >/dev/null",
  "command -v pnpm >/dev/null 2>&1 || npm install --ignore-scripts -g pnpm@11.25.0 || sudo -n npm install --ignore-scripts -g pnpm@11.25.0",
  "git --version",
  "pnpm --version",
].join("\n");

// Imported source alone does not re-key a prepared sandbox snapshot.
export const FACTORY_TOOLING_VERSION = createHash("sha256")
  .update(INSTALL_SCRIPT)
  .digest("hex")
  .slice(0, 16);

/** Prepare tooling once per snapshot, before repository data enters the VM. */
export async function installFactoryTooling(
  sandbox: VercelSandboxSession
): Promise<void> {
  const result = await sandbox.run({ command: INSTALL_SCRIPT });
  if (result.exitCode !== 0) {
    throw new Error(
      "Could not prepare factory Git and pnpm tooling. Check the sandbox image and npm registry access."
    );
  }
}

import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/local.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

/**
 * Constructs the just-bash sandbox backend: a pure-JS bash interpreter
 * over a virtual filesystem stored under `.eve/sandbox-cache/`. It
 * needs no daemon or VM, but commands run in a simulated shell — no
 * real binaries (`git`, `node`, package managers) and no network
 * isolation.
 *
 * The `just-bash` package is not bundled with eve. When it is missing,
 * `eve dev` installs it into the application automatically (disable
 * with `autoInstall: false`); production processes fail with an
 * actionable install error instead. Configuring this backend pins it
 * unconditionally — when you want fallback behavior, use
 * `defaultBackend()` instead.
 */
export function justbash(opts?: JustBashSandboxCreateOptions): SandboxBackend {
  return createJustBashSandboxBackend({ createOptions: opts });
}

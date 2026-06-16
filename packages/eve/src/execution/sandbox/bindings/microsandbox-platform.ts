import { existsSync } from "node:fs";
import { access } from "node:fs/promises";

import { MICROSANDBOX_USER } from "#execution/sandbox/bindings/microsandbox-options.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { Sandbox as MicrosandboxSandbox } from "microsandbox";

/**
 * Synchronously reports whether this host can run microsandbox at all:
 * macOS on Apple Silicon, or Linux (glibc) with KVM available. Used by
 * `defaultSandbox()`'s availability chain.
 */
export function isMicrosandboxPlatformSupported(): boolean {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return true;
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    if (!isGlibcLinux()) {
      return false;
    }
    return process.env.MSB_PATH !== undefined || existsSync("/dev/kvm");
  }
  return false;
}

// The microsandbox npm package ships native bindings for darwin-arm64
// and linux-{x64,arm64}-gnu only; musl hosts cannot load it.
function isGlibcLinux(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime === "string";
  } catch {
    return false;
  }
}

/**
 * Validates the host before loading the microsandbox package, turning
 * unsupported platforms into actionable errors instead of opaque
 * native-binding resolution failures.
 */
export async function assertMicrosandboxPlatformCandidate(): Promise<void> {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return;
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    if (!isGlibcLinux()) {
      throw new Error(
        "The microsandbox sandbox backend requires a glibc-based Linux distribution; musl " +
          "hosts are not supported. Use docker() or vercel() instead.",
      );
    }
    if (process.env.MSB_PATH !== undefined || (await doesPathExist("/dev/kvm"))) {
      return;
    }
    throw new Error(
      "The microsandbox sandbox backend requires Linux with KVM enabled. `/dev/kvm` is not " +
        "available on this host. Enable KVM, set MSB_PATH for a custom runtime, or use " +
        "docker() / vercel().",
    );
  }

  throw new Error(
    "The microsandbox sandbox backend supports Linux with KVM or macOS on Apple Silicon. " +
      `Current host is ${process.platform}/${process.arch}. Use docker() or ` +
      "vercel() on this host.",
  );
}

async function doesPathExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time setup applied to sandboxes created from the raw base image:
 * verifies Bash, creates the `vercel-sandbox` user, and hands it
 * `/workspace`.
 */
export async function ensureMicrosandboxBaseRuntime(
  sandbox: MicrosandboxSandbox,
  options: { readonly log?: (message: string) => void } = {},
): Promise<void> {
  const handle = await sandbox.execStreamWith("bash", (builder) =>
    builder.args(["-lc", MICROSANDBOX_BASE_SETUP_SCRIPT]).cwd("/").user("root"),
  );
  const output = await collectMicrosandboxBaseRuntimeOutput(handle, options.log);
  if (output.exitCode !== 0) {
    throw new Error(
      `Failed to initialize the microsandbox base runtime. ${
        output.stderr || output.stdout
      }`.trim(),
    );
  }
}

async function collectMicrosandboxBaseRuntimeOutput(
  handle: AsyncIterable<
    | { readonly kind: "stdout" | "stderr"; readonly data: Uint8Array }
    | { readonly kind: "started"; readonly pid: number }
    | { readonly kind: "exited"; readonly code: number }
  >,
  log: ((message: string) => void) | undefined,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  let stderrLineBuffer = "";
  let exitCode: number | undefined;

  for await (const event of handle) {
    if (event.kind === "stdout") {
      const chunk = stdoutDecoder.decode(event.data, { stream: true });
      stdout = appendOutput(stdout, chunk);
      stdoutLineBuffer = emitMicrosandboxBaseRuntimeLogs(stdoutLineBuffer + chunk, log);
    } else if (event.kind === "stderr") {
      const chunk = stderrDecoder.decode(event.data, { stream: true });
      stderr = appendOutput(stderr, chunk);
      stderrLineBuffer = emitMicrosandboxBaseRuntimeLogs(stderrLineBuffer + chunk, log);
    } else if (event.kind === "exited") {
      exitCode = event.code;
      break;
    }
  }

  const finalStdout = stdoutDecoder.decode();
  const finalStderr = stderrDecoder.decode();
  if (finalStdout.length > 0) {
    stdout = appendOutput(stdout, finalStdout);
    stdoutLineBuffer = emitMicrosandboxBaseRuntimeLogs(stdoutLineBuffer + finalStdout, log);
  }
  if (finalStderr.length > 0) {
    stderr = appendOutput(stderr, finalStderr);
    stderrLineBuffer = emitMicrosandboxBaseRuntimeLogs(stderrLineBuffer + finalStderr, log);
  }
  emitMicrosandboxBaseRuntimeLogLine(stdoutLineBuffer, log);
  emitMicrosandboxBaseRuntimeLogLine(stderrLineBuffer, log);

  if (exitCode === undefined) {
    throw new Error("Microsandbox base runtime setup ended without an exit event.");
  }

  return { exitCode, stderr, stdout };
}

function emitMicrosandboxBaseRuntimeLogs(
  text: string,
  log: ((message: string) => void) | undefined,
): string {
  const lines = text.split(/\r?\n/u);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    emitMicrosandboxBaseRuntimeLogLine(line, log);
  }
  return remainder;
}

function emitMicrosandboxBaseRuntimeLogLine(
  line: string,
  log: ((message: string) => void) | undefined,
): void {
  const message = line.match(/^eve-base-runtime: ?(.*)$/u)?.[1];
  if (message !== undefined && message.length > 0) {
    log?.(message);
  }
}

function appendOutput(output: string, chunk: string): string {
  const next = output + chunk;
  return next.length > 20_000 ? next.slice(-20_000) : next;
}

const MICROSANDBOX_BASE_SETUP_SCRIPT = `
set -euo pipefail

log_step() {
  printf 'eve-base-runtime: %s\\n' "$*" >&2
}

log_step "checking bash"
command -v bash >/dev/null 2>&1

log_step "checking sandbox user"
if ! id -u ${MICROSANDBOX_USER} >/dev/null 2>&1; then
  command -v useradd >/dev/null 2>&1
  log_step "create sandbox user: ${MICROSANDBOX_USER}"
  useradd -m -s /bin/bash ${MICROSANDBOX_USER}
fi

log_step "prepare workspace directory: ${WORKSPACE_ROOT}"
mkdir -p ${WORKSPACE_ROOT}
chown ${MICROSANDBOX_USER}:${MICROSANDBOX_USER} ${WORKSPACE_ROOT}
`;

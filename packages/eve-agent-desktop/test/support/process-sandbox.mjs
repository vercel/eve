// A sandbox backed by real processes on this machine, shaped like eve's sandbox
// session so the same tool code runs against it. Two details matter for the
// abort behaviour under test, and both come from eve and the sandbox SDK:
//
// - eve binds the tool call's signal onto every session method before the tool
//   sees the session (`bindSandboxAbortSignal`), so `spawn` always receives it.
//   `bindCallAbort` below does the same.
// - the SDK's process handle kills the command when that signal aborts, its
//   `wait()` rejects with the abort reason instead of the exit code, and its
//   `kill()` resolves once the process is gone.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

export function createProcessSandbox() {
  const children = [];
  return {
    children,
    async spawn({ command, signal }) {
      const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      const abortReason = () => signal?.reason ?? new Error("aborted");
      let exited;
      const wait = () => {
        exited ??= new Promise((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(abortReason());
            return;
          }
          if (gone(child)) {
            resolve({ exitCode: child.exitCode ?? 1 });
            return;
          }
          const onClose = (code) => {
            cleanup();
            resolve({ exitCode: code ?? 1 });
          };
          const onAbort = () => {
            cleanup();
            reject(abortReason());
          };
          function cleanup() {
            child.off("close", onClose);
            signal?.removeEventListener("abort", onAbort);
          }
          child.once("close", onClose);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return exited;
      };
      signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      if (signal?.aborted === true) child.kill("SIGTERM");
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        wait,
        async kill() {
          if (gone(child)) return;
          const closed = new Promise((resolve) => child.once("close", resolve));
          child.kill("SIGTERM");
          await closed;
        },
      };
    },
    async readBinaryFile({ path }) {
      try {
        return readFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

/** What eve does to a session before a tool sees it: it composes the call's signal into every method. */
export function bindCallAbort(sandbox, signal) {
  const compose = (inner) => (inner === undefined ? signal : AbortSignal.any([signal, inner]));
  const bound = { ...sandbox };
  for (const method of ["spawn", "run"]) {
    if (typeof sandbox[method] !== "function") continue;
    bound[method] = (options) => sandbox[method]({ ...options, signal: compose(options.signal) });
  }
  return bound;
}

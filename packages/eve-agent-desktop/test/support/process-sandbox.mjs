import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";

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
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        wait,
        async kill() {
          if (gone(child)) return;
          const closed = new Promise((resolve) => child.once("close", resolve));
          child.kill("SIGTERM");
          await closed;
        },
      };
    },
    async removePath({ path, force, recursive, signal }) {
      signal?.throwIfAborted();
      await rm(path, { force, recursive });
      signal?.throwIfAborted();
    },
    async readFile({ path, signal }) {
      signal?.throwIfAborted();
      try {
        return new Response(readFileSync(path)).body;
      } catch {
        return null;
      }
    },
  };
}

export function bindCallAbort(sandbox, signal) {
  const compose = (inner) => (inner === undefined ? signal : AbortSignal.any([signal, inner]));
  const bound = { ...sandbox };
  for (const method of ["spawn", "run"]) {
    if (typeof sandbox[method] !== "function") continue;
    bound[method] = (options) => sandbox[method]({ ...options, signal: compose(options.signal) });
  }
  return bound;
}

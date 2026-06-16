import type { SandboxProcess } from "../../src/shared/sandbox-session.js";

/**
 * Returns a no-op {@link SandboxProcess} whose stdout/stderr streams are
 * empty and whose `wait()` resolves with exit code 0.
 *
 * Test fixtures that only exercise the `run` path can use this to
 * satisfy the `spawn` member required by the public `SandboxSession`
 * surface without having to thread real process plumbing through every
 * file.
 */
export function stubSpawnProcess(): SandboxProcess {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    async wait() {
      return { exitCode: 0 };
    },
    async kill() {},
  };
}

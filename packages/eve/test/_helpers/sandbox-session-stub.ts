import type { SandboxProcess } from "../../src/shared/sandbox-session.js";

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

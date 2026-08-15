import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxSession,
} from "#shared/sandbox-session.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";

interface RecordedCall {
  readonly method: string;
  readonly abortSignal: AbortSignal | undefined;
}

function createRecordingSession(calls: RecordedCall[]): SandboxSession {
  const record = (method: string, abortSignal: AbortSignal | undefined): void => {
    calls.push({ abortSignal, method });
  };
  const commandResult: SandboxCommandResult = { exitCode: 0, stderr: "", stdout: "" };

  return {
    id: "sbx_recording",
    resolvePath: (path: string) => `/workspace/${path}`,
    run: async (options) => {
      record("run", options.abortSignal);
      return commandResult;
    },
    spawn: (options): Promise<SandboxProcess> => {
      record("spawn", options.abortSignal);
      return Promise.reject(new Error("spawn is unused in this test"));
    },
    readFile: async (options) => {
      record("readFile", options.abortSignal);
      return null;
    },
    readBinaryFile: async (options) => {
      record("readBinaryFile", options.abortSignal);
      return null;
    },
    readTextFile: async (options) => {
      record("readTextFile", options.abortSignal);
      return null;
    },
    writeFile: async (options) => {
      record("writeFile", options.abortSignal);
    },
    writeBinaryFile: async (options) => {
      record("writeBinaryFile", options.abortSignal);
    },
    writeTextFile: async (options) => {
      record("writeTextFile", options.abortSignal);
    },
    removePath: async (options) => {
      record("removePath", options.abortSignal);
    },
    setNetworkPolicy: async () => {},
  };
}

describe("bindSandboxAbortSignal", () => {
  it("injects the bound signal into every I/O method by default", async () => {
    const calls: RecordedCall[] = [];
    const signal = new AbortController().signal;
    const bound = bindSandboxAbortSignal(createRecordingSession(calls), signal);

    await bound.run({ command: "echo hi" });
    await expect(bound.spawn({ command: "sleep 1" })).rejects.toThrow("unused");
    await bound.readFile({ path: "a.txt" });
    await bound.readBinaryFile({ path: "a.bin" });
    await bound.readTextFile({ path: "a.txt" });
    await bound.writeFile({ content: new ReadableStream<Uint8Array>(), path: "a.txt" });
    await bound.writeBinaryFile({ content: new Uint8Array(), path: "a.bin" });
    await bound.writeTextFile({ content: "hello", path: "a.txt" });
    await bound.removePath({ path: "a.txt" });

    expect(calls.map((call) => call.method)).toEqual([
      "run",
      "spawn",
      "readFile",
      "readBinaryFile",
      "readTextFile",
      "writeFile",
      "writeBinaryFile",
      "writeTextFile",
      "removePath",
    ]);
    for (const call of calls) {
      expect(call.abortSignal).not.toBe(signal);
      expect(call.abortSignal?.aborted).toBe(false);
    }
    expect(new Set(calls.map((call) => call.abortSignal)).size).toBe(calls.length);
  });

  it("does not accumulate backend listeners on the bound signal", async () => {
    const calls: RecordedCall[] = [];
    const recordingSession = createRecordingSession(calls);
    const listenerSession: SandboxSession = {
      ...recordingSession,
      run: async (options) => {
        options.abortSignal?.addEventListener("abort", () => {}, { once: true });
        return recordingSession.run(options);
      },
    };
    const controller = new AbortController();
    const bound = bindSandboxAbortSignal(listenerSession, controller.signal);

    for (let index = 0; index < 20; index += 1) {
      await bound.run({ command: "echo hi" });
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("propagates the bound abort signal to a default operation signal", async () => {
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    const bound = bindSandboxAbortSignal(createRecordingSession(calls), controller.signal);

    await bound.run({ command: "echo hi" });
    const operationSignal = calls[0]?.abortSignal;
    const reason = new Error("turn cancelled");
    controller.abort(reason);

    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe(reason);
  });

  it("composes a call-level signal with the bound signal instead of replacing it", async () => {
    const calls: RecordedCall[] = [];
    const boundController = new AbortController();
    const bound = bindSandboxAbortSignal(createRecordingSession(calls), boundController.signal);

    const callController = new AbortController();
    await bound.run({ abortSignal: callController.signal, command: "echo hi" });

    const composed = calls[0]?.abortSignal;
    expect(composed).toBeDefined();
    expect(composed).not.toBe(boundController.signal);
    expect(composed).not.toBe(callController.signal);
    expect(composed?.aborted).toBe(false);

    callController.abort(new Error("call-level abort"));
    expect(composed?.aborted).toBe(true);

    await bound.run({ abortSignal: new AbortController().signal, command: "echo again" });
    const second = calls[1]?.abortSignal;
    expect(second?.aborted).toBe(false);
    boundController.abort(new Error("turn cancelled"));
    expect(second?.aborted).toBe(true);
  });

  it("passes non-I/O members through unchanged", () => {
    const calls: RecordedCall[] = [];
    const session = createRecordingSession(calls);
    const bound = bindSandboxAbortSignal(session, new AbortController().signal);

    expect(bound.id).toBe("sbx_recording");
    expect(bound.resolvePath("nested/file.txt")).toBe("/workspace/nested/file.txt");
  });
});

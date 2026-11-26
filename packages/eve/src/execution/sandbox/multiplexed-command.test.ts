import { describe, expect, it, vi } from "vitest";

import {
  adaptMultiplexedCommandToSandboxProcess,
  adaptStreamingCommandToSandboxProcess,
} from "#execution/sandbox/multiplexed-command.js";

interface TestLog {
  readonly data: string;
  readonly output: "stderr" | "stdout";
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    text += decoder.decode(value, { stream: true });
  }
}

function logs(...values: ReadonlyArray<TestLog>): () => AsyncIterable<TestLog> {
  return async function* generateLogs() {
    yield* values;
  };
}

describe("adaptMultiplexedCommandToSandboxProcess", () => {
  it("splits logs and waits for both command and log completion", async () => {
    const releaseLogs = Promise.withResolvers<void>();
    const waitingForLogs = Promise.withResolvers<void>();
    const command = {
      kill: vi.fn(async () => undefined),
      async *logs() {
        yield { data: "out one\n", output: "stdout" } as const;
        waitingForLogs.resolve();
        await releaseLogs.promise;
        yield { data: "err\n", output: "stderr" } as const;
        yield { data: "out two\n", output: "stdout" } as const;
      },
      wait: vi.fn(async () => ({ exitCode: 7 })),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log) => log.output,
    });
    const stdout = readText(process.stdout);
    const stderr = readText(process.stderr);

    await waitingForLogs.promise;
    let waitSettled = false;
    const firstWait = Promise.resolve(process.wait()).then((result) => {
      waitSettled = true;
      return result;
    });
    const secondWait = Promise.resolve(process.wait());
    await Promise.resolve();
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    releaseLogs.resolve();
    await expect(firstWait).resolves.toEqual({ exitCode: 7 });
    await expect(secondWait).resolves.toEqual({ exitCode: 7 });
    await expect(stdout).resolves.toBe("out one\nout two\n");
    await expect(stderr).resolves.toBe("err\n");
    expect(command.wait).toHaveBeenCalledOnce();
  });

  it("propagates log failures to both streams and wait", async () => {
    const failure = new Error("log transport failed");
    const command = {
      kill: vi.fn(async () => undefined),
      async *logs() {
        yield { data: "partial", output: "stdout" } as const;
        throw failure;
      },
      wait: vi.fn(async () => ({ exitCode: 0 })),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log) => log.output,
    });

    await expect(readText(process.stdout)).rejects.toBe(failure);
    await expect(readText(process.stderr)).rejects.toBe(failure);
    await expect(process.wait()).rejects.toBe(failure);
  });

  it("continues routing logs after one output is canceled", async () => {
    const releaseLogs = Promise.withResolvers<void>();
    const command = {
      kill: vi.fn(async () => undefined),
      async *logs() {
        await releaseLogs.promise;
        yield { data: "discarded", output: "stdout" } as const;
        yield { data: "preserved", output: "stderr" } as const;
      },
      wait: vi.fn(async () => ({ exitCode: 0 })),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log) => log.output,
    });

    await process.stdout.cancel();
    const stderr = readText(process.stderr);
    releaseLogs.resolve();

    await expect(stderr).resolves.toBe("preserved");
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it("invokes command kill only once", async () => {
    const releaseKill = Promise.withResolvers<void>();
    const command = {
      kill: vi.fn(() => releaseKill.promise),
      logs: logs(),
      wait: vi.fn(async () => ({ exitCode: 0 })),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log) => log.output,
    });

    const firstKill = process.kill();
    const secondKill = process.kill();
    await Promise.resolve();
    expect(command.kill).toHaveBeenCalledOnce();

    releaseKill.resolve();
    await Promise.all([firstKill, secondKill]);
    await process.kill();
    expect(command.kill).toHaveBeenCalledOnce();
  });

  it("does not kill a command that exited before its signal aborts", async () => {
    const controller = new AbortController();
    const command = {
      kill: vi.fn(async () => undefined),
      logs: logs(),
      wait: vi.fn(async () => ({ exitCode: 0 })),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      abortSignal: controller.signal,
      command,
      getOutput: (log) => log.output,
    });

    await process.wait();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(command.kill).not.toHaveBeenCalled();
  });

  it("rejects both streams with the abort reason when the signal aborts", async () => {
    const controller = new AbortController();
    const stop = new Error("stop");
    const command = {
      kill: vi.fn(async () => undefined),
      async *logs({ signal }: { readonly signal?: AbortSignal }) {
        yield* [];
        await new Promise((_, reject) => {
          const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort);
        });
      },
      wait: vi.fn(() => new Promise<{ exitCode: number }>(() => {})),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      abortSignal: controller.signal,
      command,
      getOutput: (log: TestLog) => log.output,
    });
    const stdout = readText(process.stdout);
    const stderr = readText(process.stderr);

    controller.abort(stop);

    await expect(stdout).rejects.toBe(stop);
    await expect(stderr).rejects.toBe(stop);
  });

  it("kills a running command when its signal aborts after the log stream failed", async () => {
    const controller = new AbortController();
    const failure = new Error("log transport failed");
    const command = {
      kill: vi.fn(async () => undefined),
      async *logs() {
        yield* [];
        throw failure;
      },
      wait: vi.fn(() => new Promise<{ exitCode: number }>(() => {})),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      abortSignal: controller.signal,
      command,
      getOutput: (log: TestLog) => log.output,
    });

    await expect(readText(process.stdout)).rejects.toBe(failure);
    controller.abort();

    await vi.waitFor(() => expect(command.kill).toHaveBeenCalledOnce());
  });

  it("writes stdin chunks in order and closes stdin when the stream closes", async () => {
    const written: string[] = [];
    const command = {
      closeStdin: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      logs: logs(),
      wait: vi.fn(async () => ({ exitCode: 0 })),
      writeStdin: vi.fn(async (data: Uint8Array) => {
        written.push(new TextDecoder().decode(data));
      }),
    };
    const process = adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log: TestLog) => log.output,
      stdin: command,
    });
    const writer = process.stdin!.getWriter();
    const encoder = new TextEncoder();

    await writer.write(encoder.encode("one\n"));
    await writer.write(encoder.encode("two\n"));
    await writer.close();

    expect(written).toEqual(["one\n", "two\n"]);
    expect(command.closeStdin).toHaveBeenCalledOnce();
  });

  it("omits stdin unless requested", () => {
    const process = adaptMultiplexedCommandToSandboxProcess({
      command: {
        kill: async () => undefined,
        logs: logs(),
        wait: async () => ({ exitCode: 0 }),
      },
      getOutput: (log: TestLog) => log.output,
    });

    expect(process.stdin).toBeUndefined();
  });

  it("cancels a stalled stdin write on kill, writer abort, and caller abort after exit", async () => {
    const stalled = (_data: Uint8Array, options: { readonly abortSignal?: AbortSignal }) =>
      new Promise<void>((_, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason));
      });
    const open = () => {
      const command = {
        closeStdin: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined),
        logs: logs(),
        wait: async () => ({ exitCode: 0 }),
        writeStdin: vi.fn(stalled),
      };
      const process = adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log: TestLog) => log.output,
        stdin: command,
      });
      return { command, writer: process.stdin!.getWriter(), process };
    };

    const killed = open();
    const killedWrite = killed.writer.write(new Uint8Array([1]));
    await vi.waitFor(() => expect(killed.command.writeStdin).toHaveBeenCalledOnce());
    await killed.process.kill();
    await expect(killedWrite).rejects.toThrow();

    const aborted = open();
    const abortedWrite = aborted.writer.write(new Uint8Array([1]));
    await vi.waitFor(() => expect(aborted.command.writeStdin).toHaveBeenCalledOnce());
    await aborted.writer.abort(new Error("done"));
    await expect(abortedWrite).rejects.toThrow("done");
    expect(aborted.command.closeStdin).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const command = {
      closeStdin: async () => undefined,
      kill: async () => undefined,
      logs: logs(),
      wait: async () => ({ exitCode: 0 }),
      writeStdin: vi.fn(stalled),
    };
    const exited = adaptMultiplexedCommandToSandboxProcess({
      abortSignal: controller.signal,
      command,
      getOutput: (log: TestLog) => log.output,
      stdin: command,
    });
    const exitedWrite = exited.stdin!.getWriter().write(new Uint8Array([1]));
    await exited.wait();
    controller.abort(new Error("caller"));
    await expect(exitedWrite).rejects.toThrow("caller");
  });
});

describe("adaptStreamingCommandToSandboxProcess", () => {
  it("resolves on start, streams stdout and stderr, and releases on completion", async () => {
    const finished = Promise.withResolvers<{ exitCode: number }>();
    const onRelease = vi.fn();
    const kill = vi.fn(async () => undefined);
    let streams!: {
      stderr: { write(chunk: string): boolean };
      stdout: { write(chunk: string): boolean };
    };

    const process = await adaptStreamingCommandToSandboxProcess({
      onRelease,
      async start({ onStart, stderr, stdout }) {
        streams = { stderr, stdout };
        onStart({ kill });
        stdout.write("out one\n");
        return await finished.promise;
      },
    });

    const stdout = readText(process.stdout);
    const stderr = readText(process.stderr);
    expect(onRelease).not.toHaveBeenCalled();

    streams.stderr.write("err\n");
    streams.stdout.write("out two\n");
    finished.resolve({ exitCode: 7 });

    await expect(process.wait()).resolves.toEqual({ exitCode: 7 });
    await expect(stdout).resolves.toBe("out one\nout two\n");
    await expect(stderr).resolves.toBe("err\n");
    expect(onRelease).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills once, releases immediately, and propagates abort reason to streams and wait", async () => {
    const controller = new AbortController();
    const stop = new Error("stop");
    const onRelease = vi.fn();
    const kill = vi.fn(async () => undefined);
    const fail = Promise.withResolvers<{ exitCode: number }>();

    const process = await adaptStreamingCommandToSandboxProcess({
      abortSignal: controller.signal,
      onRelease,
      async start({ onStart }) {
        onStart({ kill });
        return await fail.promise;
      },
    });

    controller.abort(stop);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    expect(onRelease).toHaveBeenCalledOnce();
    fail.reject(new DOMException("Aborted", "AbortError"));

    await expect(readText(process.stdout)).rejects.toBe(stop);
    await expect(readText(process.stderr)).rejects.toBe(stop);
    await expect(process.wait()).rejects.toBe(stop);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("kills an already-started command when abort rejects start before spawn resumes", async () => {
    const controller = new AbortController();
    const stop = new Error("stop immediately");
    const onRelease = vi.fn();
    const kill = vi.fn(async () => undefined);

    const process = await adaptStreamingCommandToSandboxProcess({
      abortSignal: controller.signal,
      onRelease,
      async start({ onStart }) {
        onStart({ kill });
        controller.abort(stop);
        throw new DOMException("Aborted", "AbortError");
      },
    });

    await expect(process.wait()).rejects.toBe(stop);
    expect(kill).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("releases and rejects when starting the command fails before onStart", async () => {
    const onRelease = vi.fn();
    const boom = new Error("network down");

    await expect(
      adaptStreamingCommandToSandboxProcess({
        onRelease,
        async start() {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(onRelease).toHaveBeenCalledOnce();
  });
});

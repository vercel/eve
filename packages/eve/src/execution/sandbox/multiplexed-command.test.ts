import { describe, expect, it, vi } from "vitest";

import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";

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
});

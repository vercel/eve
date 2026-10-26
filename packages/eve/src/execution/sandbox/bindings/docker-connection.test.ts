import { describe, expect, it, vi } from "vitest";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";

import { createDockerConnection } from "./docker-connection.js";

function createCli(input: {
  readonly onRun?: (args: readonly string[]) => Promise<void>;
}): DockerCli {
  return {
    run: vi.fn(async (args: readonly string[]) => {
      await input.onRun?.(args);
      return { exitCode: 0, stderr: "", stdout: "", stdoutBytes: Buffer.alloc(0) };
    }),
    stream: vi.fn(() => {
      throw new Error("not used");
    }),
  };
}

function createFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    content: new TextEncoder().encode(`file ${String(index)}`),
    path: `/workspace/file-${String(index)}.txt`,
  }));
}

describe("createDockerConnection writeFiles", () => {
  it("bounds how many writes run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const cli = createCli({
      onRun: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
      },
    });
    const connection = createDockerConnection({ cli, containerIdentity: "eve-sbx" });

    const written = connection.writeFiles({ files: createFiles(40) });
    while (inFlight > 0 || release.length > 0) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      release.pop()?.();
      await Promise.resolve();
    }
    await written;

    expect(peak).toBe(8);
    expect(cli.run).toHaveBeenCalledTimes(40);
  });

  it("writes every file in the batch", async () => {
    const cli = createCli({});
    const connection = createDockerConnection({ cli, containerIdentity: "eve-sbx" });

    await connection.writeFiles({ files: createFiles(3) });

    expect(vi.mocked(cli.run).mock.calls.map(([args]) => args.at(-1))).toEqual([
      "mkdir -p '/workspace' && cat > '/workspace/file-0.txt'",
      "mkdir -p '/workspace' && cat > '/workspace/file-1.txt'",
      "mkdir -p '/workspace' && cat > '/workspace/file-2.txt'",
    ]);
  });

  it("rejects an aborted batch before writing anything", async () => {
    const cli = createCli({});
    const connection = createDockerConnection({ cli, containerIdentity: "eve-sbx" });

    await expect(
      connection.writeFiles({ abortSignal: AbortSignal.abort(), files: createFiles(2) }),
    ).rejects.toThrow();
    expect(cli.run).not.toHaveBeenCalled();
  });
});

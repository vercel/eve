import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHarnessSandboxHandle } from "#execution/harness-agent/sandbox-session.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const mocks = vi.hoisted(() => ({
  getVercelSandbox: vi.fn(),
}));

vi.mock("#compiled/@vercel/sandbox/index.js", () => ({
  Sandbox: { get: mocks.getVercelSandbox },
}));

function createVercelSandbox(
  input: {
    readonly leasedPort?: number;
    readonly routes?: readonly number[];
  } = {},
) {
  const finishedCommand = (
    command: { readonly exitCode?: number; readonly stdout?: string } = {},
  ) => ({
    exitCode: command.exitCode ?? 0,
    stderr: vi.fn().mockResolvedValue(""),
    stdout: vi.fn().mockResolvedValue(command.stdout ?? ""),
  });
  const detachedCommand = {
    kill: vi.fn().mockResolvedValue(undefined),
    async *logs() {},
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
  const user = {
    runCommand: vi
      .fn()
      .mockImplementation(
        async (options: { readonly args?: readonly string[]; readonly detached?: boolean }) => {
          if (options.detached) {
            return detachedCommand;
          }
          if (options.args?.[1]?.includes("EVE_HARNESS_PORTS")) {
            return input.leasedPort === undefined
              ? finishedCommand({ exitCode: 75 })
              : finishedCommand({ stdout: String(input.leasedPort) });
          }
          return finishedCommand();
        },
      ),
    writeFiles: vi.fn().mockResolvedValue(undefined),
  };
  return {
    asUser: vi.fn().mockReturnValue(user),
    detachedCommand,
    domain: (port: number) => `https://port-${port}.example.test`,
    routes: (input.routes ?? [4319]).map((port) => ({ port })),
    user,
  };
}

function createEveSandbox(): SandboxSession {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  return {
    id: "eve-session",
    readBinaryFile: vi.fn().mockResolvedValue(null),
    readFile: vi.fn().mockResolvedValue(null),
    readTextFile: vi.fn().mockResolvedValue(null),
    removePath: vi.fn().mockResolvedValue(undefined),
    resolvePath: (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
    run,
    setNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({
      kill: vi.fn().mockResolvedValue(undefined),
      stderr: new ReadableStream(),
      stdout: new ReadableStream(),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" }),
    }),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  mocks.getVercelSandbox.mockReset();
});

describe("createHarnessSandboxHandle", () => {
  it("uses the current basic sandbox session for an in-process harness", async () => {
    const session = createEveSandbox();
    const handle = await createHarnessSandboxHandle({
      harness: "pi",
      sandbox: session,
    });

    expect(mocks.getVercelSandbox).not.toHaveBeenCalled();
    expect(handle.bridge).toBeUndefined();
    expect(handle.session.id).toBe("eve-session");
    expect(handle.session.description).toContain("/workspace");
    expect(handle.session.defaultWorkingDirectory).toBe("/workspace/.eve-harness");
    expect(session.run).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it("passes an exposed port and its WebSocket endpoint to a bridge harness", async () => {
    const session = createEveSandbox();
    const vercelSandbox = createVercelSandbox({ leasedPort: 4319 });
    mocks.getVercelSandbox.mockResolvedValue(vercelSandbox);

    const handle = await createHarnessSandboxHandle({
      harness: "codex",
      sandbox: session,
    });

    expect(mocks.getVercelSandbox).toHaveBeenCalledWith({ name: "eve-session", resume: false });
    expect(handle.bridge).toEqual({
      port: 4319,
      portEndpoint: { url: "wss://port-4319.example.test/" },
    });
    expect(vercelSandbox.asUser).toHaveBeenCalledWith("vercel-sandbox");
    expect(vercelSandbox.user.runCommand).toHaveBeenCalledTimes(2);
    expect(vercelSandbox.user.runCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(session.run).not.toHaveBeenCalled();
    await handle.dispose();
    expect(vercelSandbox.user.runCommand).toHaveBeenCalledTimes(3);
  });

  it("selects an available exposed port instead of an occupied one", async () => {
    const session = createEveSandbox();
    const vercelSandbox = createVercelSandbox({
      leasedPort: 4320,
      routes: [4319, 4320],
    });
    mocks.getVercelSandbox.mockResolvedValue(vercelSandbox);

    const handle = await createHarnessSandboxHandle({
      harness: "claude-code",
      sandbox: session,
    });

    expect(handle.bridge).toEqual({
      port: 4320,
      portEndpoint: { url: "wss://port-4320.example.test/" },
    });
    const reservation = vercelSandbox.user.runCommand.mock.calls[1]?.[0];
    expect(reservation?.args?.[1]).toContain("server.listen");
    expect(reservation?.env).toMatchObject({ EVE_HARNESS_PORTS: "4319 4320" });
    await handle.dispose();
  });

  it("uses the existing Vercel Sandbox user for bridge commands and bootstrap files", async () => {
    const session = createEveSandbox();
    const vercelSandbox = createVercelSandbox({ leasedPort: 4319 });
    mocks.getVercelSandbox.mockResolvedValue(vercelSandbox);

    const handle = await createHarnessSandboxHandle({
      harness: "claude-code",
      sandbox: session,
    });

    await handle.session.run({
      command: "whoami",
      env: { TOKEN: "secret" },
      workingDirectory: "/workspace/ms",
    });
    expect(vercelSandbox.user.runCommand).toHaveBeenLastCalledWith({
      args: ["-lc", "whoami"],
      cmd: "bash",
      cwd: "/workspace/ms",
      env: {
        TMPDIR: "/workspace/.eve-harness/tmp",
        TOKEN: "secret",
      },
      signal: undefined,
    });

    await handle.session.writeTextFile({
      content: "bridge config",
      path: "/workspace/.eve-harness/config.json",
    });
    expect(vercelSandbox.user.writeFiles).toHaveBeenCalledWith(
      [
        {
          content: Buffer.from("bridge config"),
          path: "/workspace/.eve-harness/config.json",
        },
      ],
      { signal: undefined },
    );

    const process = await handle.session.spawn({ command: "node bridge.mjs" });
    await process.wait();
    expect(vercelSandbox.user.runCommand).toHaveBeenLastCalledWith({
      args: ["-lc", "node bridge.mjs"],
      cmd: "bash",
      cwd: "/workspace/.eve-harness",
      detached: true,
      env: { TMPDIR: "/workspace/.eve-harness/tmp" },
      signal: undefined,
    });
    expect(vercelSandbox.detachedCommand.wait).toHaveBeenCalledOnce();

    const commands = vercelSandbox.user.runCommand.mock.calls
      .flatMap(([options]) => options.args ?? [])
      .join(" ");
    expect(commands).not.toMatch(/useradd|chgrp|chmod|chown/);
    await handle.dispose();
  });

  it("fails before starting a harness when every exposed port is unavailable", async () => {
    const session = createEveSandbox();
    const vercelSandbox = createVercelSandbox({ routes: [4319, 4320] });
    mocks.getVercelSandbox.mockResolvedValue(vercelSandbox);

    await expect(
      createHarnessSandboxHandle({
        harness: "codex",
        sandbox: session,
      }),
    ).rejects.toThrow("No exposed Vercel Sandbox port is available");
  });

  it("requires an exposed port for a bridge harness", async () => {
    const session = createEveSandbox();
    mocks.getVercelSandbox.mockResolvedValue({ routes: [] });

    await expect(
      createHarnessSandboxHandle({
        harness: "claude-code",
        sandbox: session,
      }),
    ).rejects.toThrow("requires an exposed Vercel Sandbox port");
    expect(session.run).not.toHaveBeenCalled();
  });
});

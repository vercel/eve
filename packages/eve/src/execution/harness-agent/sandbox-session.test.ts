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
    readonly routes?: readonly number[];
  } = {},
) {
  return {
    domain: (port: number) => `https://port-${port}.example.test`,
    routes: (input.routes ?? [4319]).map((port) => ({ port })),
  };
}

function createEveSandbox(input: { readonly leasedPort?: number } = {}): SandboxSession {
  const run = vi.fn().mockImplementation(async (options: { readonly command: string }) => {
    if (options.command.includes("EVE_HARNESS_PORTS")) {
      return input.leasedPort === undefined
        ? { exitCode: 75, stderr: "", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: String(input.leasedPort) };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
  });
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
    const session = createEveSandbox({ leasedPort: 4319 });
    const vercelSandbox = createVercelSandbox();
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
    expect(session.run).toHaveBeenCalledTimes(2);
    expect(session.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workingDirectory: "/workspace" }),
    );
    await handle.dispose();
    expect(session.run).toHaveBeenCalledTimes(3);
  });

  it("selects an available exposed port instead of an occupied one", async () => {
    const session = createEveSandbox({ leasedPort: 4320 });
    const vercelSandbox = createVercelSandbox({ routes: [4319, 4320] });
    mocks.getVercelSandbox.mockResolvedValue(vercelSandbox);

    const handle = await createHarnessSandboxHandle({
      harness: "claude-code",
      sandbox: session,
    });

    expect(handle.bridge).toEqual({
      port: 4320,
      portEndpoint: { url: "wss://port-4320.example.test/" },
    });
    const reservation = vi.mocked(session.run).mock.calls[1]?.[0];
    expect(reservation?.command).toContain("server.listen");
    expect(reservation?.env).toMatchObject({ EVE_HARNESS_PORTS: "4319 4320" });
    await handle.dispose();
  });

  it("uses the existing eve sandbox session for bridge commands and bootstrap files", async () => {
    const session = createEveSandbox({ leasedPort: 4319 });
    const vercelSandbox = createVercelSandbox();
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
    expect(session.run).toHaveBeenLastCalledWith({
      command: "whoami",
      env: {
        TMPDIR: "/workspace/.eve-harness/tmp",
        TOKEN: "secret",
      },
      workingDirectory: "/workspace/ms",
    });

    await handle.session.writeTextFile({
      content: "bridge config",
      path: "/workspace/.eve-harness/config.json",
    });
    expect(session.writeTextFile).toHaveBeenCalledWith({
      content: "bridge config",
      path: "/workspace/.eve-harness/config.json",
    });

    const process = await handle.session.spawn({ command: "node bridge.mjs" });
    await process.wait();
    expect(session.spawn).toHaveBeenLastCalledWith({
      command: "node bridge.mjs",
      env: { TMPDIR: "/workspace/.eve-harness/tmp" },
    });
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

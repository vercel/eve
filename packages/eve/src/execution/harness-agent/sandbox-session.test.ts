import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHarnessSandboxHandle } from "#execution/harness-agent/sandbox-session.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const mocks = vi.hoisted(() => ({
  getVercelSandbox: vi.fn(),
}));

vi.mock("#compiled/@vercel/sandbox/index.js", () => ({
  Sandbox: { get: mocks.getVercelSandbox },
}));

function createEveSandbox(): SandboxSession {
  const run = vi.fn().mockImplementation(async (options: { readonly command: string }) => ({
    exitCode: 0,
    stderr: "",
    stdout: options.command.includes("EVE_HARNESS_PORTS") ? "4319" : "",
  }));
  return {
    id: "eve-session",
    readBinaryFile: vi.fn().mockResolvedValue(null),
    readFile: vi.fn().mockResolvedValue(null),
    readTextFile: vi.fn().mockResolvedValue(null),
    removePath: vi.fn().mockResolvedValue(undefined),
    resolvePath: (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
    run,
    setNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockRejectedValue(new Error("unused")),
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
    const handle = await createHarnessSandboxHandle({ harness: "pi", sandbox: session });

    expect(mocks.getVercelSandbox).not.toHaveBeenCalled();
    expect(handle.bridge).toBeUndefined();
    expect(handle.session.id).toBe("eve-session");
    expect(handle.session.description).toContain("/workspace");
    expect(handle.session.defaultWorkingDirectory).toBe("/tmp/eve-harness");
    expect(session.run).toHaveBeenCalledTimes(1);
  });

  it("passes an exposed port and its WebSocket endpoint to a bridge harness", async () => {
    const session = createEveSandbox();
    mocks.getVercelSandbox.mockResolvedValue({
      domain: (port: number) => `https://port-${port}.example.test`,
      routes: [{ port: 4319 }],
    });

    const handle = await createHarnessSandboxHandle({ harness: "codex", sandbox: session });

    expect(mocks.getVercelSandbox).toHaveBeenCalledWith({ name: "eve-session", resume: false });
    expect(handle.bridge).toEqual({
      port: 4319,
      portEndpoint: { url: "wss://port-4319.example.test/" },
    });
    await handle.dispose();
  });

  it("requires an exposed port for a bridge harness", async () => {
    const session = createEveSandbox();
    mocks.getVercelSandbox.mockResolvedValue({ routes: [] });

    await expect(
      createHarnessSandboxHandle({ harness: "claude-code", sandbox: session }),
    ).rejects.toThrow("requires an exposed Vercel Sandbox port");
    expect(session.run).not.toHaveBeenCalled();
  });
});

import { constants } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  accessSync: vi.fn(),
}));
const fsPromisesMocks = vi.hoisted(() => ({
  access: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  accessSync: fsMocks.accessSync,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: fsPromisesMocks.access,
}));

import {
  assertMicrosandboxPlatformCandidate,
  ensureMicrosandboxBaseRuntime,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/microsandbox-platform.js";

describe.skipIf(process.platform !== "linux")("isMicrosandboxPlatformSupported", () => {
  beforeEach(() => {
    fsMocks.accessSync.mockReset();
    fsPromisesMocks.access.mockReset();
    vi.stubEnv("MSB_PATH", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a KVM device the current user cannot read and write", () => {
    fsMocks.accessSync.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(isMicrosandboxPlatformSupported()).toBe(false);
    expect(fsMocks.accessSync).toHaveBeenCalledWith("/dev/kvm", constants.R_OK | constants.W_OK);
  });

  it("accepts a KVM device the current user can read and write", () => {
    expect(isMicrosandboxPlatformSupported()).toBe(true);
  });

  it("preserves an explicit custom microsandbox runtime without probing local KVM", () => {
    vi.stubEnv("MSB_PATH", "/opt/custom/msb");

    expect(isMicrosandboxPlatformSupported()).toBe(true);
    expect(fsMocks.accessSync).not.toHaveBeenCalled();
  });

  it("accepts an explicit custom microsandbox runtime without asynchronous KVM access", async () => {
    vi.stubEnv("MSB_PATH", "/opt/custom/msb");
    fsPromisesMocks.access.mockRejectedValue(new Error("permission denied"));

    await expect(assertMicrosandboxPlatformCandidate()).resolves.toBeUndefined();
    expect(fsPromisesMocks.access).not.toHaveBeenCalled();
  });

  it("rejects an explicitly configured microsandbox before loading it without KVM access", async () => {
    fsPromisesMocks.access.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(assertMicrosandboxPlatformCandidate()).rejects.toThrow(
      "requires Linux with KVM enabled and read/write access to `/dev/kvm`",
    );
    expect(fsPromisesMocks.access).toHaveBeenCalledWith(
      "/dev/kvm",
      constants.R_OK | constants.W_OK,
    );
  });

  it("accepts an explicitly configured microsandbox with KVM access", async () => {
    await expect(assertMicrosandboxPlatformCandidate()).resolves.toBeUndefined();
    expect(fsPromisesMocks.access).toHaveBeenCalledWith(
      "/dev/kvm",
      constants.R_OK | constants.W_OK,
    );
  });
});

describe.skipIf(process.platform === "win32")("ensureMicrosandboxBaseRuntime", () => {
  it("streams base runtime setup step logs", async () => {
    const logs: string[] = [];
    const builderState = {
      args: [] as string[],
      cwd: "",
      user: "",
    };
    const builder = {
      args(args: string[]) {
        builderState.args = args;
        return builder;
      },
      cwd(cwd: string) {
        builderState.cwd = cwd;
        return builder;
      },
      user(user: string) {
        builderState.user = user;
        return builder;
      },
    };
    const sandbox = {
      async execStreamWith(command: string, configure: (input: typeof builder) => unknown) {
        expect(command).toBe("bash");
        configure(builder);
        return createExecHandle([
          { data: Buffer.from("eve-base-runtime: checking bash\n"), kind: "stderr" },
          { data: Buffer.from("framework setup output ignored\n"), kind: "stdout" },
          {
            data: Buffer.from("eve-base-runtime: prepare workspace directory: /workspace"),
            kind: "stderr",
          },
          { data: Buffer.from("\n"), kind: "stderr" },
          { code: 0, kind: "exited" },
        ]);
      },
    };

    await ensureMicrosandboxBaseRuntime(sandbox as never, {
      log: (message) => logs.push(message),
    });

    expect(builderState.args[0]).toBe("-lc");
    expect(builderState.args[1]).toContain("checking bash");
    expect(builderState.args[1]).not.toContain("apt-get");
    expect(builderState.args[1]).not.toContain("dnf");
    expect(builderState.args[1]).not.toContain("apk");
    expect(builderState.args[1]).not.toContain("node_24");
    expect(builderState.args[1]).not.toContain("npm install");
    expect(builderState.cwd).toBe("/");
    expect(builderState.user).toBe("root");
    expect(logs).toEqual(["checking bash", "prepare workspace directory: /workspace"]);
  });
});

function createExecHandle(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

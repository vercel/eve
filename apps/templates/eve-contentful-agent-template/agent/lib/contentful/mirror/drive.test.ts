import { Drive, Sandbox } from "@vercel/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MirrorWorkspace } from "./sync";

const sdk = vi.hoisted(() => ({
  create: vi.fn<typeof Sandbox.create>(),
  getOrCreate: vi.fn<typeof Drive.getOrCreate>(),
}));

const { runScheduledMirrorSync, sandboxMirrorWorkspace, withMirrorDrive } =
  await import("./drive");

type MirrorSandbox = Parameters<typeof sandboxMirrorWorkspace>[0];
type CommandResult = Awaited<ReturnType<MirrorSandbox["runCommand"]>>;

const finished = (stdout = "", exitCode = 0, stderr = ""): CommandResult => ({
  exitCode,
  stderr: () => Promise.resolve(stderr),
  stdout: () => Promise.resolve(stdout),
});

const fakeSandbox = () =>
  ({
    readFileToBuffer: vi.fn<MirrorSandbox["readFileToBuffer"]>(),
    runCommand: vi.fn<MirrorSandbox["runCommand"]>(() =>
      Promise.resolve(finished())
    ),
    stop: vi.fn(() => Promise.resolve()),
    writeFiles: vi.fn<MirrorSandbox["writeFiles"]>(() => Promise.resolve()),
  }) satisfies MirrorSandbox & { stop: () => Promise<void> };

/* A real SDK Drive built from metadata; construction makes no API requests. */
const driveFixture = (currentSessionId?: string) =>
  new Drive({
    drive: {
      createdAt: 0,
      currentSessionId,
      id: "drive_1",
      maxSizeBytes: 1024,
      name: "contentful-mirror",
      projectId: "prj_1",
      region: "iad1",
      updatedAt: 0,
    },
  });

/*
 * Presents the fake as the SDK sandbox returned by Sandbox.create. A real
 * Sandbox requires a live API session, so the fake's methods are installed on
 * an instance of the SDK prototype; any other SDK method fails loudly.
 */
const asSdkSandbox = <T extends MirrorSandbox & { stop: () => Promise<void> }>(
  sandbox: T
) =>
  Object.assign(
    // SAFETY: drive.ts calls only readFileToBuffer, runCommand, writeFiles, and stop, which the fake overrides.
    Object.create(Sandbox.prototype) as Sandbox & AsyncDisposable,
    sandbox
  );

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));

describe("sandbox mirror workspace", () => {
  it("creates parent directories before writing files", async () => {
    const sandbox = fakeSandbox();
    const files = [
      { content: "a", path: "/contentful/sample-site/a.md" },
      { content: "b", path: "/contentful/sample-site/b.md" },
      { content: "{}", path: "/contentful/manifest.json" },
    ];

    await sandboxMirrorWorkspace(sandbox).writeFiles(files);

    expect(sandbox.runCommand).toHaveBeenCalledExactlyOnceWith("mkdir", [
      "-p",
      "--",
      "/contentful/sample-site",
      "/contentful",
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledExactlyOnceWith(files);
  });

  it("lists entry files and removes files in batches", async () => {
    const sandbox = fakeSandbox();
    sandbox.runCommand.mockResolvedValueOnce(
      finished("/contentful/sample-site/a.md\n/contentful/sample-docs/b.md\n")
    );
    const workspace = sandboxMirrorWorkspace(sandbox);

    await expect(workspace.listEntryFiles()).resolves.toEqual([
      "/contentful/sample-site/a.md",
      "/contentful/sample-docs/b.md",
    ]);
    await workspace.remove(
      Array.from(
        { length: 250 },
        (_, index) => `/contentful/sample-site/${index}.md`
      )
    );

    const removals = sandbox.runCommand.mock.calls.filter(
      ([command]) => command === "rm"
    );
    expect(removals.map(([, args]) => args.length)).toEqual([202, 52]);
  });

  it("returns null for a missing file and throws on command failures", async () => {
    const sandbox = fakeSandbox();
    sandbox.readFileToBuffer.mockResolvedValue(null);
    sandbox.runCommand.mockResolvedValue(finished("", 1, "denied"));
    const workspace = sandboxMirrorWorkspace(sandbox);

    await expect(workspace.readText("/contentful/manifest.json")).resolves.toBe(
      null
    );
    await expect(workspace.listEntryFiles()).rejects.toThrow(
      "find failed in the mirror sandbox (exit 1): denied"
    );
  });
});

describe("withMirrorDrive", () => {
  it("skips when another sandbox holds the read-write mount", async () => {
    sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));
    const sync = vi.fn<(workspace: MirrorWorkspace) => Promise<void>>();

    await expect(withMirrorDrive(sync)).resolves.toBeNull();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("mounts the Drive read-write without network access and stops the sandbox after a failure", async () => {
    const drive = driveFixture();
    const sandbox = fakeSandbox();
    sdk.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockResolvedValue(asSdkSandbox(sandbox));

    await expect(
      withMirrorDrive(() => Promise.reject(new Error("sync failed")))
    ).rejects.toThrow("sync failed");
    expect(sdk.getOrCreate).toHaveBeenCalledWith({
      name: "contentful-mirror",
      region: "iad1",
    });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: { "/contentful": drive },
        networkPolicy: "deny-all",
        persistent: false,
        region: "iad1",
      })
    );
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });
});

describe("runScheduledMirrorSync", () => {
  it("logs a failed sync and resolves after stopping the sandbox", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sandbox = fakeSandbox();
    sandbox.readFileToBuffer.mockRejectedValue(new Error("read failed"));
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(asSdkSandbox(sandbox));

    await expect(runScheduledMirrorSync("full")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "contentful.mirror_sync_failed",
      { message: "read failed", mode: "full" }
    );
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });
});

beforeEach(() => {
  vi.spyOn(Drive, "getOrCreate").mockImplementation(sdk.getOrCreate);
  vi.spyOn(Sandbox, "create").mockImplementation(sdk.create);
});

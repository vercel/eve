import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRIVE_NAME,
  DRIVE_REGION,
  DriveBusyError,
  resolveDrivePath,
  sandboxDriveWorkspace,
  withWritableDrive,
} from "./drive";
import {
  commandFinished,
  driveFixture,
  sandboxFixture,
  spyOnSandboxFactories,
} from "./testing/sandbox";

describe("Drive configuration", () => {
  it.each([
    [{ DRIVE_NAME: "team-drive", DRIVE_REGION: "" }, "team-drive", "iad1"],
    [{ DRIVE_NAME: undefined, DRIVE_REGION: "sfo1" }, "eve-drive", "sfo1"],
  ])(
    "reads %o from the environment, treating empty values as unset",
    async (env, name, region) => {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      vi.resetModules();

      const drive = await import("./drive");

      expect([drive.DRIVE_NAME, drive.DRIVE_REGION]).toStrictEqual([
        name,
        region,
      ]);
    }
  );
});

describe(resolveDrivePath, () => {
  it.each([
    ["notes/today.md", "/drive/notes/today.md"],
    ["a b/c d.md", "/drive/a b/c d.md"],
    [`${"é".repeat(127)}a`, `/drive/${"é".repeat(127)}a`],
  ])("resolves %j under the mount", (relative, absolute) => {
    expect(resolveDrivePath(relative)).toBe(absolute);
  });

  it.each([
    "",
    "/etc/passwd",
    "../secrets",
    "notes/../../secrets",
    "notes//a.md",
    "notes/./a.md",
    "notes/",
    "a\0b",
    " notes/a.md",
    "notes/a.md ",
    "x".repeat(256),
    // 128 characters but 256 UTF-8 bytes.
    "é".repeat(128),
  ])("rejects %j", (path) => {
    expect(() => resolveDrivePath(path)).toThrow(
      `Invalid Drive path "${path}".`
    );
  });
});

describe(sandboxDriveWorkspace, () => {
  it("creates each parent directory once before writing files", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    const files = [
      { content: "a", path: "/drive/notes/a.md" },
      { content: "b", path: "/drive/notes/b.md" },
      { content: new Uint8Array([1]), path: "/drive/c.bin" },
    ];

    await sandboxDriveWorkspace(sandbox).writeFiles(files);

    expect(runCommand).toHaveBeenCalledExactlyOnceWith("mkdir", [
      "-p",
      "--",
      "/drive/notes",
      "/drive",
    ]);
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(runCommand.mock.invocationCallOrder[0]).toBeLessThan(
      writeFiles.mock.invocationCallOrder[0]
    );
  });

  it("removes files without treating paths as options", async () => {
    const { runCommand, sandbox } = sandboxFixture();

    await sandboxDriveWorkspace(sandbox).remove(["/drive/a.md", "/drive/b.md"]);

    expect(runCommand).toHaveBeenCalledExactlyOnceWith("rm", [
      "-f",
      "--",
      "/drive/a.md",
      "/drive/b.md",
    ]);
  });

  it("runs no commands for empty writes and removals", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    const workspace = sandboxDriveWorkspace(sandbox);

    await workspace.writeFiles([]);
    await workspace.remove([]);

    expect(runCommand).not.toHaveBeenCalled();
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("throws with trimmed stderr and skips the write when mkdir fails", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    runCommand.mockResolvedValue(commandFinished(1, "denied\n"));

    await expect(
      sandboxDriveWorkspace(sandbox).writeFiles([
        { content: "a", path: "/drive/a.md" },
      ])
    ).rejects.toThrow(
      new Error("mkdir failed in the Drive sandbox (exit 1): denied")
    );
    expect(writeFiles).not.toHaveBeenCalled();
  });
});

describe(DriveBusyError, () => {
  it("names the Drive and the session holding it", () => {
    const error = new DriveBusyError("sess_1");

    expect(error).toMatchObject({
      message: `Drive "${DRIVE_NAME}" is in use by Vercel Sandbox session sess_1.`,
      name: "DriveBusyError",
      sessionId: "sess_1",
    });
  });
});

describe(withWritableDrive, () => {
  let sdk: ReturnType<typeof spyOnSandboxFactories>;

  beforeEach(() => {
    sdk = spyOnSandboxFactories();
  });

  it("mounts the Drive read-write without network access, passes the workspace to the callback, and stops the sandbox", async () => {
    const drive = driveFixture();
    const { sandbox, stop, writeFiles } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockResolvedValue(sandbox);
    const file = { content: "a", path: "/drive/a.md" };

    await expect(
      withWritableDrive(async (workspace) => {
        await workspace.writeFiles([file]);
        return "ok";
      })
    ).resolves.toBe("ok");
    expect(sdk.getOrCreate).toHaveBeenCalledExactlyOnceWith({
      name: DRIVE_NAME,
      region: DRIVE_REGION,
    });
    expect(sdk.create).toHaveBeenCalledExactlyOnceWith({
      mounts: { "/drive": drive },
      networkPolicy: "deny-all",
      persistent: false,
      region: DRIVE_REGION,
      tags: { application: "eve-vercel-drives-starter" },
      timeout: 300_000,
    });
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(stop).toHaveBeenCalledExactlyOnceWith();
  });

  it("treats an empty session ID as a free Drive", async () => {
    const { sandbox } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture(""));
    sdk.create.mockResolvedValue(sandbox);

    await expect(
      withWritableDrive(vi.fn<() => Promise<string>>().mockResolvedValue("ok"))
    ).resolves.toBe("ok");
  });

  it("throws DriveBusyError without creating a sandbox when another sandbox holds the mount", async () => {
    sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));
    const write = vi.fn<() => Promise<void>>();

    await expect(withWritableDrive(write)).rejects.toStrictEqual(
      new DriveBusyError("sess_1")
    );
    expect(sdk.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("throws DriveBusyError for the session that took the mount while the sandbox was being created", async () => {
    sdk.getOrCreate
      .mockResolvedValueOnce(driveFixture())
      .mockResolvedValueOnce(driveFixture("sess_2"));
    sdk.create.mockRejectedValue(new Error("drive already attached"));

    const result = withWritableDrive(vi.fn<() => Promise<void>>());

    await expect(result).rejects.toBeInstanceOf(DriveBusyError);
    await expect(result).rejects.toMatchObject({ sessionId: "sess_2" });
  });

  it.each([
    [
      "the Drive is still free",
      (getOrCreate: typeof sdk.getOrCreate) =>
        getOrCreate.mockResolvedValueOnce(driveFixture()),
    ],
    [
      "the Drive cannot be re-read",
      (getOrCreate: typeof sdk.getOrCreate) =>
        getOrCreate.mockRejectedValueOnce(new Error("lookup failed")),
    ],
  ])("rethrows the create error when %s", async (_case, recheck) => {
    const createError = new Error("quota exceeded");
    recheck(sdk.getOrCreate.mockResolvedValueOnce(driveFixture()));
    sdk.create.mockRejectedValue(createError);

    await expect(withWritableDrive(vi.fn<() => Promise<void>>())).rejects.toBe(
      createError
    );
  });

  it("stops the sandbox and rethrows when the callback fails", async () => {
    const { sandbox, stop } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);
    const writeError = new Error("write failed");

    await expect(
      withWritableDrive(
        vi.fn<() => Promise<void>>().mockRejectedValue(writeError)
      )
    ).rejects.toBe(writeError);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns the callback result and logs when stopping the sandbox fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sandbox, stop } = sandboxFixture();
    stop.mockRejectedValue(new Error("stop failed"));
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);

    await expect(
      withWritableDrive(vi.fn<() => Promise<string>>().mockResolvedValue("ok"))
    ).resolves.toBe("ok");
    expect(warn).toHaveBeenCalledExactlyOnceWith("drive.stop_failed", {
      message: "stop failed",
    });
  });
});

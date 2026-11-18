import { beforeEach, describe, expect, it } from "vitest";

import {
  driveFixture,
  sandboxFixture,
  spyOnSandboxFactories,
} from "../lib/testing/sandbox";
import { toolContext } from "../lib/testing/tools";
import saveToDrive from "./save_to_drive";

const save = async (path: string, content = "héllo") =>
  await saveToDrive.execute({ content, path }, toolContext("save_to_drive"));

describe("save_to_drive", () => {
  let sdk: ReturnType<typeof spyOnSandboxFactories>;

  beforeEach(() => {
    sdk = spyOnSandboxFactories();
  });

  it("writes the file under the Drive mount and reports its UTF-8 size", async () => {
    const { runCommand, sandbox, stop, writeFiles } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);

    await expect(save("notes/standup.md")).resolves.toStrictEqual({
      bytes: 6,
      path: "/drive/notes/standup.md",
      saved: true,
    });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith("mkdir", [
      "-p",
      "--",
      "/drive/notes",
    ]);
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith([
      { content: "héllo", path: "/drive/notes/standup.md" },
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns invalid_path without opening the Drive", async () => {
    await expect(save("../secrets.md")).resolves.toStrictEqual({
      message:
        'Invalid Drive path "../secrets.md". Use a relative path like "notes/today.md".',
      reason: "invalid_path",
      saved: false,
    });
    expect(sdk.getOrCreate).not.toHaveBeenCalled();
  });

  it("returns drive_busy when another sandbox holds the Drive", async () => {
    sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));

    await expect(save("notes/standup.md")).resolves.toStrictEqual({
      reason: "drive_busy",
      saved: false,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("propagates unexpected Drive failures", async () => {
    const createError = new Error("quota exceeded");
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockRejectedValue(createError);

    await expect(save("notes/standup.md")).rejects.toBe(createError);
  });
});

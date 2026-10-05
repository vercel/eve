import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  skillFileStorageKey,
  SKILL_FILES_INDEX_KEY,
  type SkillFileSource,
} from "#channel/skill-files.js";

const files: Readonly<Record<string, Uint8Array>> = {
  "skill.md": new TextEncoder().encode("# Triage\n"),
  "references/api.md": new Uint8Array([0xe9, 0x00]),
  "big.bin": new Uint8Array(MAX_SKILL_FILE_BYTES + 1),
};
const memory: SkillFileSource = {
  listFiles: async () =>
    Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.byteLength })),
  listDirectories: async () => ["references"],
  readFile: async (_skill, path) => files[path]!,
};

// A production build's index and server assets; `stale.md` ships altered bytes.
const shipped = new Uint8Array([1, 2, 3]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bundled = createCompiledSkillFileSource({
  compiledArtifactsSource: { kind: "bundled" },
  openStorage: async () => ({
    getItemRaw: async (key) =>
      key === SKILL_FILES_INDEX_KEY
        ? JSON.stringify({
            version: 1,
            skills: [
              [
                "triage",
                [
                  ["SKILL.md", 3, digest(shipped)],
                  ["huge.md", MAX_SKILL_FILE_BYTES + 1, null],
                  ["stale.md", 3, digest(new Uint8Array([9, 9, 9]))],
                ],
                ["templates"],
              ],
            ],
          })
        : key === skillFileStorageKey(digest(shipped))
          ? shipped
          : new Uint8Array([7, 7, 7]),
  }),
  workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
});

describe("bundled skill files", () => {
  it("lists files and directories from the build index", async () => {
    await expect(bundled.listFiles("triage")).resolves.toEqual([
      { path: "SKILL.md", size: 3 },
      { path: "huge.md", size: MAX_SKILL_FILE_BYTES + 1 },
      { path: "stale.md", size: 3 },
    ]);
    await expect(bundled.listDirectories("triage")).resolves.toEqual(["templates"]);
    await expect(bundled.listDirectories("missing")).resolves.toEqual([]);
  });
});

describe("readSkillFile", () => {
  it.each([
    ["../other/SKILL.md", memory, "invalid-path"],
    ["./SKILL.md", memory, "invalid-path"],
    ["/etc/passwd", memory, "invalid-path"],
    ["C:/Windows/win.ini", memory, "invalid-path"],
    ["references\\api.md", memory, "invalid-path"],
    ["references//api.md", memory, "invalid-path"],
    ["SKILL.md\0.png", memory, "invalid-path"],
    ["", memory, "invalid-path"],
    ["references/API.md", memory, "unknown-file"],
    ["big.bin", memory, "too-large"],
    ["huge.md", bundled, "too-large"],
    ["stale.md", bundled, "unavailable"],
    [undefined, memory, files["skill.md"]],
    ["SKILL.md", memory, files["skill.md"]],
    ["references/api.md", memory, files["references/api.md"]],
    [undefined, bundled, shipped],
  ] as const)("reads %j", async (path, source, expected) => {
    const read = readSkillFile({ path, skill: "triage", source });
    if (typeof expected === "string") {
      await expect(read).rejects.toMatchObject({ code: expected });
    } else {
      await expect(read).resolves.toEqual(expected);
    }
  });
});

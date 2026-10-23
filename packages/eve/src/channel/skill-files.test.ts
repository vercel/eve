import { describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
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

// A production build's embedded skill files.
const shipped = new Uint8Array([1, 2, 3]);
const bundled = createCompiledSkillFileSource({
  bundledSkillFiles: {
    skills: [
      [
        "triage",
        [
          ["SKILL.md", 3, "shipped"],
          ["huge.md", MAX_SKILL_FILE_BYTES + 1, null],
        ],
        ["templates"],
      ],
    ],
    read: async (sha256) => (sha256 === "shipped" ? shipped : new Uint8Array()),
  },
  compiledArtifactsSource: { kind: "bundled" },
  workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
});
const unbuilt = createCompiledSkillFileSource({
  compiledArtifactsSource: { kind: "bundled" },
  workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
});

describe("bundled skill files", () => {
  it("lists files and directories from the build index", async () => {
    await expect(bundled.listFiles("triage")).resolves.toEqual([
      { path: "SKILL.md", size: 3 },
      { path: "huge.md", size: MAX_SKILL_FILE_BYTES + 1 },
    ]);
    await expect(bundled.listDirectories("triage")).resolves.toEqual(["templates"]);
    await expect(bundled.listDirectories("missing")).resolves.toEqual([]);
  });

  it("returns a copy that callers can mutate without changing later reads", async () => {
    const first = await bundled.readFile("triage", "SKILL.md");
    first.fill(0);
    await expect(bundled.readFile("triage", "SKILL.md")).resolves.toEqual(shipped);
    expect(shipped).toEqual(new Uint8Array([1, 2, 3]));
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
    [undefined, unbuilt, "unavailable"],
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

import { describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  installBundledSkillFiles,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  type SkillFileSource,
} from "#channel/skill-files.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

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

// A production build's embedded skill files. Like a `bytes:` module, every
// read of one digest resolves the same array.
const shipped = new Uint8Array([1, 2, 3]);
const bundledSession = createRuntimeSession("bundled-skill-files");
await withRuntimeSession(bundledSession, () =>
  installBundledSkillFiles({
    index: JSON.stringify({
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
    }),
    read: async () => shipped,
  }),
);
const bundled = createCompiledSkillFileSource({
  compiledArtifactsSource: { kind: "bundled" },
  workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
});
const inBundledSession = <T>(fn: () => Promise<T>) => withRuntimeSession(bundledSession, fn);

describe("bundled skill files", () => {
  it("lists files and directories from the build index", async () => {
    await inBundledSession(async () => {
      await expect(bundled.listFiles("triage")).resolves.toEqual([
        { path: "SKILL.md", size: 3 },
        { path: "huge.md", size: MAX_SKILL_FILE_BYTES + 1 },
      ]);
      await expect(bundled.listDirectories("triage")).resolves.toEqual(["templates"]);
      await expect(bundled.listDirectories("missing")).resolves.toEqual([]);
    });
  });

  it("returns a copy, so mutating a read does not change later reads", async () => {
    await inBundledSession(async () => {
      const first = await bundled.readFile("triage", "SKILL.md");
      first.fill(0);
      await expect(bundled.readFile("triage", "SKILL.md")).resolves.toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });
  });

  it("is unavailable when the server carries no embedded skill files", async () => {
    await expect(bundled.listFiles("triage")).rejects.toMatchObject({ code: "unavailable" });
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
    [undefined, memory, files["skill.md"]],
    ["SKILL.md", memory, files["skill.md"]],
    ["references/api.md", memory, files["references/api.md"]],
    [undefined, bundled, shipped],
  ] as const)("reads %j", async (path, source, expected) => {
    const read = inBundledSession(() => readSkillFile({ path, skill: "triage", source }));
    if (typeof expected === "string") {
      await expect(read).rejects.toMatchObject({ code: expected });
    } else {
      await expect(read).resolves.toEqual(expected);
    }
  });
});

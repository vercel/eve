import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import {
  DISCOVER_SKILL_COLLISION,
  DISCOVER_SKILL_ENTRY_NOT_DIRECTORY,
  DISCOVER_SKILL_FRONTMATTER_INVALID,
  DISCOVER_SKILL_MARKDOWN_MISSING,
  discoverSkills,
} from "#discover/skills.js";

async function withDiskAgentProject<T>(
  callback: (paths: { agentRoot: string; appRoot: string; tempRoot: string }) => Promise<T>,
): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), "eve-skills-"));
  const appRoot = join(tempRoot, "app");
  const agentRoot = join(appRoot, "agent");

  try {
    await mkdir(join(agentRoot, "skills"), { recursive: true });
    return await callback({ agentRoot, appRoot, tempRoot });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function trySymlink(
  target: string,
  path: string,
  type?: "dir" | "file" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      return false;
    }

    throw error;
  }
}

describe("discoverSkills (memory)", () => {
  it("discovers packaged, markdown, and module-backed skills", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: [
        "skills/get-weather/scripts",
        "skills/get-weather/references",
        "skills/get-weather/assets",
      ],
      agentFiles: {
        "skills/get-weather/skill.MD": [
          "---",
          "description: Use the weather tool before answering forecast questions.",
          "license: MIT",
          "metadata:",
          "  audience: forecast",
          "---",
          "When the user asks about weather, call the weather tool before answering.",
        ].join("\n"),
        "skills/handoff.mjs":
          'throw new Error("skill modules should not execute during discovery");\n',
        "skills/weather-research.md": [
          "---",
          "description: Research complex weather questions before replying.",
          "---",
          "Research complex weather questions before replying.",
        ].join("\n"),
      },
    });

    const result = await discoverSkills({
      agentRoot: project.agentRoot,
      source: project.source,
    });
    const packagedSkillRoot = join(resolve(project.agentRoot), "skills", "get-weather");

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      {
        assetsPath: join(packagedSkillRoot, "assets"),
        description: "Use the weather tool before answering forecast questions.",
        sourceKind: "skill-package",
        license: "MIT",
        logicalPath: "skills/get-weather/skill.MD",
        markdown: "When the user asks about weather, call the weather tool before answering.",
        metadata: {
          audience: "forecast",
        },
        name: "get-weather",
        referencesPath: join(packagedSkillRoot, "references"),
        rootPath: packagedSkillRoot,
        scriptsPath: join(packagedSkillRoot, "scripts"),
        skillFilePath: join(packagedSkillRoot, "skill.MD"),
        skillId: "get-weather",
        sourceId: "skills/get-weather/skill.MD",
      },
      {
        sourceKind: "module",
        logicalPath: "skills/handoff.mjs",
        sourceId: "skills/handoff.mjs",
      },
      {
        definition: {
          description: "Research complex weather questions before replying.",
          markdown: "Research complex weather questions before replying.",
        },
        sourceKind: "markdown",
        logicalPath: "skills/weather-research.md",
        sourceId: "skills/weather-research.md",
      },
    ]);

    expect(
      createAgentSourceManifest({
        agentRoot: project.agentRoot,
        appRoot: project.appRoot,
        skills: result.skills,
      }).skills,
    ).toEqual(result.skills);
  });

  it("discovers flat cjs module-backed skills", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "skills/handoff.cjs": 'module.exports = { name: "handoff" };\n',
      },
    });

    const result = await discoverSkills({
      agentRoot: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      {
        sourceKind: "module",
        logicalPath: "skills/handoff.cjs",
        sourceId: "skills/handoff.cjs",
      },
    ]);
  });

  it("accepts flat markdown skills while still reporting unsupported entries and missing SKILL.md files", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["skills/empty-skill"],
      agentFiles: {
        "skills/get-weather.md": "Use the weather tool before answering forecast questions.",
        "skills/notes.txt": "unsupported",
      },
    });

    const result = await discoverSkills({
      agentRoot: project.agentRoot,
      source: project.source,
    });

    expect(result.skills).toEqual([
      {
        definition: {
          description: "Use the weather tool before answering forecast questions.",
          markdown: "Use the weather tool before answering forecast questions.",
        },
        sourceKind: "markdown",
        logicalPath: "skills/get-weather.md",
        sourceId: "skills/get-weather.md",
      },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SKILL_MARKDOWN_MISSING,
      DISCOVER_SKILL_ENTRY_NOT_DIRECTORY,
    ]);
  });

  it("reports used-frontmatter validation failures while accepting unmodeled frontmatter", async () => {
    // Frontmatter that eve does not model must not block importing a shared
    // SKILL.md from another runtime.
    const project = buildMemoryAgentProject({
      agentFiles: {
        "skills/bad-skill/SKILL.md": ["---", "description: 42", "---", "Broken frontmatter."].join(
          "\n",
        ),
        "skills/named-package/SKILL.md": [
          "---",
          "name: other-name",
          "description: Use the weather tool before answering forecast questions.",
          "argument-hint: '[location]'",
          "disable-model-invocation: true",
          "---",
          "When the user asks about weather, call the weather tool before answering.",
        ].join("\n"),
        "skills/weather-research.md": [
          "---",
          "name: other-name",
          "description: Research complex weather questions.",
          "argument-hint: '[topic]'",
          "disable-model-invocation: true",
          "---",
          "Research weather patterns before replying.",
        ].join("\n"),
      },
    });

    const result = await discoverSkills({
      agentRoot: project.agentRoot,
      source: project.source,
    });
    const namedPackageRoot = join(resolve(project.agentRoot), "skills", "named-package");

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SKILL_FRONTMATTER_INVALID,
    ]);
    expect(result.skills).toEqual([
      {
        description: "Use the weather tool before answering forecast questions.",
        sourceKind: "skill-package",
        logicalPath: "skills/named-package/SKILL.md",
        markdown: "When the user asks about weather, call the weather tool before answering.",
        name: "named-package",
        rootPath: namedPackageRoot,
        skillFilePath: join(namedPackageRoot, "SKILL.md"),
        skillId: "named-package",
        sourceId: "skills/named-package/SKILL.md",
      },
      {
        definition: {
          description: "Research complex weather questions.",
          markdown: "Research weather patterns before replying.",
        },
        sourceKind: "markdown",
        logicalPath: "skills/weather-research.md",
        sourceId: "skills/weather-research.md",
      },
    ]);
  });

  it("reports collisions between packaged and flat skill entries", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "skills/get-weather.md": [
          "---",
          "description: Use the weather tool before answering forecast questions.",
          "---",
          "When the user asks about weather, call the weather tool before answering.",
        ].join("\n"),
        "skills/get-weather/SKILL.md": [
          "---",
          "description: Use the weather tool before answering forecast questions.",
          "---",
          "When the user asks about weather, call the weather tool before answering.",
        ].join("\n"),
        "skills/research.mjs": "export default {};\n",
        "skills/research.ts": "export default {};\n",
      },
    });

    const result = await discoverSkills({
      agentRoot: project.agentRoot,
      source: project.source,
    });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SKILL_COLLISION,
      DISCOVER_SKILL_COLLISION,
    ]);
  });
});

describe("discoverSkills (disk)", () => {
  it("discovers flat markdown skills through file symlinks", async ({ skip }) => {
    await withDiskAgentProject(async ({ agentRoot, tempRoot }) => {
      const sharedSkillPath = join(tempRoot, "shared", "research-source.md");
      await mkdir(join(tempRoot, "shared"), { recursive: true });
      await writeFile(
        sharedSkillPath,
        [
          "---",
          "description: Research complex marketplace questions before replying.",
          "---",
          "Use the shared research process.",
        ].join("\n"),
      );

      const symlinkPath = join(agentRoot, "skills", "market-research.md");
      if (!(await trySymlink(sharedSkillPath, symlinkPath, "file"))) {
        skip("file symlink creation is unavailable on this platform");
      }

      const result = await discoverSkills({ agentRoot });

      expect(result.diagnostics).toEqual([]);
      expect(result.skills).toEqual([
        {
          definition: {
            description: "Research complex marketplace questions before replying.",
            markdown: "Use the shared research process.",
          },
          sourceKind: "markdown",
          logicalPath: "skills/market-research.md",
          sourceId: "skills/market-research.md",
        },
      ]);
    });
  });

  it("discovers packaged skills whose SKILL.md is a file symlink", async ({ skip }) => {
    await withDiskAgentProject(async ({ agentRoot, tempRoot }) => {
      const sharedSkillPath = join(tempRoot, "shared", "SKILL.md");
      const skillRoot = join(agentRoot, "skills", "market-research");
      const symlinkPath = join(skillRoot, "SKILL.md");
      await mkdir(join(tempRoot, "shared"), { recursive: true });
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        sharedSkillPath,
        [
          "---",
          "description: Research complex marketplace questions before replying.",
          "---",
          "Use the packaged research process.",
        ].join("\n"),
      );

      if (!(await trySymlink(sharedSkillPath, symlinkPath, "file"))) {
        skip("file symlink creation is unavailable on this platform");
      }

      const result = await discoverSkills({ agentRoot });

      expect(result.diagnostics).toEqual([]);
      expect(result.skills).toEqual([
        {
          description: "Research complex marketplace questions before replying.",
          sourceKind: "skill-package",
          logicalPath: "skills/market-research/SKILL.md",
          markdown: "Use the packaged research process.",
          name: "market-research",
          rootPath: skillRoot,
          skillFilePath: symlinkPath,
          skillId: "market-research",
          sourceId: "skills/market-research/SKILL.md",
        },
      ]);
    });
  });

  it("discovers packaged skills through directory symlinks or junctions", async ({ skip }) => {
    await withDiskAgentProject(async ({ agentRoot, tempRoot }) => {
      const sharedSkillRoot = join(tempRoot, "shared", "market-research");
      const symlinkPath = join(agentRoot, "skills", "market-research");
      await mkdir(sharedSkillRoot, { recursive: true });
      await writeFile(
        join(sharedSkillRoot, "SKILL.md"),
        [
          "---",
          "description: Research complex marketplace questions before replying.",
          "---",
          "Use the directory-linked research process.",
        ].join("\n"),
      );

      const linkType = process.platform === "win32" ? "junction" : "dir";
      if (!(await trySymlink(sharedSkillRoot, symlinkPath, linkType))) {
        skip("directory symlink or junction creation is unavailable on this platform");
      }

      const result = await discoverSkills({ agentRoot });

      expect(result.diagnostics).toEqual([]);
      expect(result.skills).toEqual([
        {
          description: "Research complex marketplace questions before replying.",
          sourceKind: "skill-package",
          logicalPath: "skills/market-research/SKILL.md",
          markdown: "Use the directory-linked research process.",
          name: "market-research",
          rootPath: symlinkPath,
          skillFilePath: join(symlinkPath, "SKILL.md"),
          skillId: "market-research",
          sourceId: "skills/market-research/SKILL.md",
        },
      ]);
    });
  });
});

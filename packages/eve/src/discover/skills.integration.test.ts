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
  it("discovers symlinked flat and packaged markdown skills", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "eve-skill-discovery-"));
    const agentRoot = join(root, "agent");
    const sharedSkillsRoot = join(root, "shared-skills");

    try {
      await mkdir(join(agentRoot, "skills", "linked-skill"), { recursive: true });
      await mkdir(join(sharedSkillsRoot, "linked-package"), { recursive: true });
      await Promise.all([
        writeFile(
          join(sharedSkillsRoot, "flat.md"),
          "Use the shared flat skill before answering.\n",
          "utf8",
        ),
        writeFile(
          join(sharedSkillsRoot, "linked-package", "SKILL.md"),
          "---\ndescription: Use the shared package skill.\n---\nUse the shared package skill.\n",
          "utf8",
        ),
        writeFile(
          join(sharedSkillsRoot, "skill.md"),
          "---\ndescription: Use the linked package markdown.\n---\nUse the linked package markdown.\n",
          "utf8",
        ),
      ]);
      try {
        await Promise.all([
          symlink(join(sharedSkillsRoot, "flat.md"), join(agentRoot, "skills", "linked-flat.md")),
          symlink(
            join(sharedSkillsRoot, "linked-package"),
            join(agentRoot, "skills", "linked-package"),
            process.platform === "win32" ? "junction" : "dir",
          ),
          symlink(
            join(sharedSkillsRoot, "skill.md"),
            join(agentRoot, "skills", "linked-skill", "SKILL.md"),
          ),
        ]);
      } catch (error) {
        if (process.platform === "win32" && isLinkPermissionError(error)) {
          context.skip("Windows does not permit file symlinks in this environment.");
          return;
        }

        throw error;
      }

      const result = await discoverSkills({ agentRoot });

      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map((skill) => skill.sourceId)).toEqual([
        "skills/linked-flat.md",
        "skills/linked-package/SKILL.md",
        "skills/linked-skill/SKILL.md",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function isLinkPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

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

  it("reports frontmatter validation failures while silently ignoring authored name fields", async () => {
    // Skill identity is path-derived, but the broader Agent Skills format
    // commonly includes a `name` field in SKILL.md / flat skill frontmatter.
    // We accept and drop the value rather than rejecting otherwise-valid
    // skill markdown.
    const project = buildMemoryAgentProject({
      agentFiles: {
        "skills/bad-skill/SKILL.md": ["---", "description: 42", "---", "Broken frontmatter."].join(
          "\n",
        ),
        "skills/named-package/SKILL.md": [
          "---",
          "name: other-name",
          "description: Use the weather tool before answering forecast questions.",
          "---",
          "When the user asks about weather, call the weather tool before answering.",
        ].join("\n"),
        "skills/weather-research.md": [
          "---",
          "name: other-name",
          "description: Research complex weather questions.",
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

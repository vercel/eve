import { describe, expect, it } from "vitest";

import {
  classifyAgentRootEntry,
  classifyLocalSubagentEntry,
  classifySkillPackageEntry,
  classifySkillsDirectoryEntry,
  getSupportedModuleBaseName,
  isProjectMarkerEntry,
  normalizeLogicalPath,
  stripLogicalPathExtension,
} from "../src/discover/filesystem.js";

describe("discovery filesystem classification", () => {
  it("classifies top-level agent entries using the locked grammar", () => {
    expect(classifyAgentRootEntry("agent.mjs", "file")).toBe("agent-config-module");
    expect(classifyAgentRootEntry("channels", "directory")).toBe("channels-directory");
    expect(classifyAgentRootEntry("connections", "directory")).toBe("connections-directory");
    expect(classifyAgentRootEntry("lib", "directory")).toBe("lib-directory");
    expect(classifyAgentRootEntry("skills", "directory")).toBe("skills-directory");
    expect(classifyAgentRootEntry("instructions", "directory")).toBe("instructions-directory");
    expect(classifyAgentRootEntry("context", "directory")).toBe("unknown");
    expect(classifyAgentRootEntry("workspace", "directory")).toBe("unknown");
    expect(classifyAgentRootEntry("instructions.md", "file")).toBe("instructions-markdown");
    expect(classifyAgentRootEntry("INSTRUCTIONS.MD", "file")).toBe("instructions-markdown");
    expect(classifyAgentRootEntry("Instructions", "directory")).toBe("unknown");
    expect(classifyAgentRootEntry("AGENT.ts", "file")).toBe("unknown");
    expect(classifyAgentRootEntry("TOOLS", "directory")).toBe("unknown");
    expect(classifyAgentRootEntry("instructions.js", "file")).toBe("instructions-module");
    expect(classifyAgentRootEntry("system.js", "file")).toBe("system-module");
    expect(classifyAgentRootEntry("system.md", "file")).toBe("system-markdown");
    expect(classifyAgentRootEntry("SYSTEM.MD", "file")).toBe("system-markdown");
    expect(isProjectMarkerEntry("package.json", "file")).toBe(true);
  });

  it("classifies local-subagent entries including invalid schedules/ directories", () => {
    expect(classifyLocalSubagentEntry("agent.js", "file")).toBe("agent-config-module");
    expect(classifyLocalSubagentEntry("INSTRUCTIONS.MD", "file")).toBe("instructions-markdown");
    expect(classifyLocalSubagentEntry("lib", "directory")).toBe("lib-directory");
    expect(classifyLocalSubagentEntry("schedules", "directory")).toBe(
      "invalid-schedules-directory",
    );
  });

  it("classifies Agent Skills package entries while preserving extra resources", () => {
    expect(classifySkillPackageEntry("SKILL.md", "file")).toBe("skill-markdown");
    expect(classifySkillPackageEntry("skill.MD", "file")).toBe("skill-markdown");
    expect(classifySkillPackageEntry("SCRIPTS", "directory")).toBe("skill-resource");
    expect(classifySkillPackageEntry("references", "directory")).toBe("skill-references-directory");
    expect(classifySkillPackageEntry("notes.md", "file")).toBe("skill-resource");
  });

  it("classifies top-level skills entries for flat files and packaged skills", () => {
    expect(classifySkillsDirectoryEntry("get-weather.md", "file")).toBe("flat-skill-markdown");
    expect(classifySkillsDirectoryEntry("get-weather.ts", "file")).toBe("flat-skill-module");
    expect(classifySkillsDirectoryEntry("get-weather", "directory")).toBe(
      "skill-package-directory",
    );
    expect(classifySkillsDirectoryEntry("notes.txt", "file")).toBe("unknown");
  });

  it("normalizes logical paths with stable slash and extension handling", () => {
    expect(normalizeLogicalPath("context/my-location.md")).toBe("context/my-location.md");
    expect(getSupportedModuleBaseName("tools/get-weather.ts")).toBe("tools/get-weather");
    expect(getSupportedModuleBaseName("tools/get-weather.js")).toBe("tools/get-weather");
    expect(getSupportedModuleBaseName("tools/get-weather.mjs")).toBe("tools/get-weather");
    expect(stripLogicalPathExtension("subagents/researcher/agent.ts")).toBe(
      "subagents/researcher/agent",
    );
  });

  it("classifies additional cjs, cts, and mts extension variants", () => {
    expect(classifyAgentRootEntry("agent.cjs", "file")).toBe("agent-config-module");
    expect(classifyAgentRootEntry("instructions.cts", "file")).toBe("instructions-module");
    expect(classifyAgentRootEntry("system.cts", "file")).toBe("system-module");
    expect(classifyLocalSubagentEntry("agent.cts", "file")).toBe("agent-config-module");
    expect(getSupportedModuleBaseName("tools/get-weather.cts")).toBe("tools/get-weather");
    expect(getSupportedModuleBaseName("tools/get-weather.mts")).toBe("tools/get-weather");
    expect(getSupportedModuleBaseName("tools/get-weather.cjs")).toBe("tools/get-weather");
  });
});

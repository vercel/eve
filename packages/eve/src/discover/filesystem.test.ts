import { describe, expect, it } from "vitest";

import {
  classifySkillsDirectoryEntry,
  getSupportedModuleBaseName,
  isGeneratedSourceMapFileName,
  isTypeScriptDeclarationFileName,
  isAuthoredTestPath,
} from "./filesystem.js";

describe("isAuthoredTestPath", () => {
  it.each(["ts", "cts", "mts", "js", "cjs", "mjs"])(
    "recognizes test modules ending in .%s",
    (extension) => {
      expect(isAuthoredTestPath(`tools/weather.test.${extension}`)).toBe(true);
      expect(isAuthoredTestPath(`tools/weather.spec.${extension}`)).toBe(true);
      expect(isAuthoredTestPath(`tools/weather.${extension}`)).toBe(false);
    },
  );

  it("reserves only exact test directories and module suffixes", () => {
    expect(isAuthoredTestPath("__tests__")).toBe(true);
    expect(isAuthoredTestPath("tools/__tests__/fixture.json")).toBe(true);
    expect(isAuthoredTestPath("tools\\__tests__\\weather.ts")).toBe(true);
    for (const path of [
      "tools/tests/weather.ts",
      "tools/test-weather.ts",
      "skills/test.md",
      "skills/weather.test.md",
      "tools/__tests__extra/weather.ts",
    ]) {
      expect(isAuthoredTestPath(path)).toBe(false);
    }
  });
});

describe("getSupportedModuleBaseName", () => {
  it("does not discover TypeScript declaration files as authored modules", () => {
    expect(getSupportedModuleBaseName("echo.d.ts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.mts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.cts")).toBeNull();
    expect(isTypeScriptDeclarationFileName("echo.d.ts")).toBe(true);
    expect(isTypeScriptDeclarationFileName("echo.ts")).toBe(false);
  });

  it("ignores generated declarations and source maps at the top level of a skills directory", () => {
    expect(classifySkillsDirectoryEntry("notes.d.ts", "file")).toBe("ignored-declaration");
    expect(classifySkillsDirectoryEntry("notes.d.ts.map", "file")).toBe("ignored-source-map");
    expect(classifySkillsDirectoryEntry("notes.mjs.map", "file")).toBe("ignored-source-map");
    expect(classifySkillsDirectoryEntry("notes.mjs", "file")).toBe("flat-skill-module");
    expect(isGeneratedSourceMapFileName("notes.js.map")).toBe(true);
    expect(isGeneratedSourceMapFileName("notes.md.map")).toBe(false);
  });
});

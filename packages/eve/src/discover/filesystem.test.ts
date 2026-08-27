import { describe, expect, it } from "vitest";

import {
  classifySkillsDirectoryEntry,
  getSupportedModuleBaseName,
  isTypeScriptDeclarationFileName,
} from "./filesystem.js";

describe("getSupportedModuleBaseName", () => {
  it("does not discover TypeScript declaration files as authored modules", () => {
    expect(getSupportedModuleBaseName("echo.d.ts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.mts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.cts")).toBeNull();
    expect(isTypeScriptDeclarationFileName("echo.d.ts")).toBe(true);
    expect(isTypeScriptDeclarationFileName("echo.ts")).toBe(false);
  });

  it("ignores generated declarations at the top level of a skills directory", () => {
    expect(classifySkillsDirectoryEntry("notes.d.ts", "file")).toBe("ignored-declaration");
    expect(classifySkillsDirectoryEntry("notes.mjs", "file")).toBe("flat-skill-module");
  });
});

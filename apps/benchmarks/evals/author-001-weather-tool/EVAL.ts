import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { workspace } from "./grader.js";

const toolPath = join(workspace, "agent/tools/get_weather.ts");

test("creates a filesystem-named weather tool", () => {
  expect(existsSync(toolPath)).toBe(true);
  const source = readFileSync(toolPath, "utf8");
  expect(source).toMatch(/defineTool\s*\(/);
  expect(source).toMatch(/city\s*:/);
  expect(source).toMatch(/temperature/i);
  expect(source).toMatch(/condition/i);
});

test("does not require approval", () => {
  const source = readFileSync(toolPath, "utf8");
  if (/approval\s*:/.test(source)) {
    expect(source).toMatch(/approval\s*:\s*never\s*\(/);
  }
});

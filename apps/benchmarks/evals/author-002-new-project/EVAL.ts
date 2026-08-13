import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { subjectDefaultAgentModel, workspace } from "./grader.js";

const projectPath = (path: string) => join(workspace, path);

test("creates a complete eve project in place", () => {
  expect(existsSync(projectPath("agent/agent.ts"))).toBe(true);
  expect(existsSync(projectPath("agent/channels/eve.ts"))).toBe(true);
  expect(existsSync(projectPath("agent/instructions.md"))).toBe(true);

  const packageJson = JSON.parse(readFileSync(projectPath("package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");
});

test("authors the requested identity without replacing the default model", () => {
  expect(readFileSync(projectPath("agent/instructions.md"), "utf8")).toMatch(/Wayfinder/i);
  expect(readFileSync(projectPath("agent/instructions.md"), "utf8")).toMatch(/travel/i);
  expect(readFileSync(projectPath("agent/agent.ts"), "utf8")).toContain(
    `model: "${subjectDefaultAgentModel()}"`,
  );
});

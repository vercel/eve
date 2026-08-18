import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { subjectDefaultAgentModel } from "./grader.js";

test("creates a complete eve project", () => {
  expect(existsSync("agent/agent.ts")).toBe(true);
  expect(existsSync("agent/channels/eve.ts")).toBe(true);
  expect(existsSync("agent/instructions.md")).toBe(true);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");
});

test("authors the requested identity without replacing the default model", () => {
  expect(readFileSync("agent/instructions.md", "utf8")).toMatch(/Wayfinder/i);
  expect(readFileSync("agent/instructions.md", "utf8")).toMatch(/travel/i);
  expect(readFileSync("agent/agent.ts", "utf8")).toContain(
    `model: "${subjectDefaultAgentModel()}"`,
  );
});

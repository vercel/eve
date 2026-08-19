import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { subjectDefaultAgentModel } from "./grader.js";

test("creates a complete eve project in place", () => {
  expect(existsSync("agent/channels/eve.ts")).toBe(true);
  expect(existsSync("agent/instructions.md")).toBe(true);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");
});

test("authors the requested identity without pinning a different model", () => {
  const instructions = readFileSync("agent/instructions.md", "utf8");
  expect(instructions).toMatch(/Wayfinder/i);
  expect(instructions).toMatch(/travel/i);

  // `agent/agent.ts` is optional, and omitting it selects the same default the
  // scaffold pins explicitly. Both shapes satisfy "use the default model"; a
  // different model id does not.
  if (existsSync("agent/agent.ts")) {
    expect(readFileSync("agent/agent.ts", "utf8")).toContain(
      `model: "${subjectDefaultAgentModel()}"`,
    );
  }
});

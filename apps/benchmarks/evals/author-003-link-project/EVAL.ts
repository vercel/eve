import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { authoringEval, workspace } from "./grader.js";

const { commands, worldEvents } = authoringEval();
const commandLog = commands.join("\n");

test("uses eve link to link the requested Vercel project without a prompt", () => {
  expect(commandLog).toMatch(/eve\s+link[^\n]*--project(?:=|\s+)wayfinder-production/i);
  expect(commandLog).toMatch(/eve\s+link[^\n]*--non-interactive/i);
  expect(worldEvents).toContainEqual({
    type: "project.linked",
    data: { project: "wayfinder-production" },
  });
});

test("pulls the linked project's environment non-interactively", () => {
  expect(commandLog).toMatch(/eve\s+link[^\n]*--non-interactive/i);
  expect(worldEvents.map((event) => event.type)).toContain("environment.pulled");
  const envPath = join(workspace, ".env.local");
  expect(existsSync(envPath)).toBe(true);
  expect(readFileSync(envPath, "utf8")).toContain("VERCEL_OIDC_TOKEN=");
});

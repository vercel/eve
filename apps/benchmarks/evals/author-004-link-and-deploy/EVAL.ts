import { expect, test } from "vitest";

import { authoringEval } from "./grader.js";

const { commands, worldEvents } = authoringEval();
const commandLog = commands.join("\n");

test("uses eve commands to link the specified project before deployment without prompting", () => {
  expect(commandLog).toMatch(/eve\s+link[^\n]*--project(?:=|\s+)wayfinder-production/i);
  expect(commandLog).toMatch(/eve\s+link[^\n]*--non-interactive/i);
  expect(worldEvents).toContainEqual({
    type: "project.linked",
    data: { project: "wayfinder-production" },
  });
});

test("uses eve deploy for a confirmed non-interactive production deployment", () => {
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--prod/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--non-interactive/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--yes/i);
  expect(worldEvents).toContainEqual({
    type: "project.deployed",
    data: { project: "wayfinder-production", url: "https://wayfinder-production.example.test" },
  });
});

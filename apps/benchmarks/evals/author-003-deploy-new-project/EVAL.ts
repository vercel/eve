import { expect, test } from "vitest";

import { authoringEval } from "./grader.js";

const { commands, worldEvents } = authoringEval();
const commandLog = commands.join("\n");

test("uses eve deploy to create and link the named Vercel project without prompting", () => {
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--project(?:=|\s+)field-notes/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--non-interactive/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--yes/i);
  expect(worldEvents).toContainEqual({
    type: "project.created",
    data: { project: "field-notes" },
  });
  expect(worldEvents).toContainEqual({
    type: "project.linked",
    data: { project: "field-notes" },
  });
});

test("deploys the newly linked project to production", () => {
  expect(worldEvents).toContainEqual({
    type: "environment.pulled",
    data: { project: "field-notes" },
  });
  expect(worldEvents).toContainEqual({
    type: "project.deployed",
    data: { project: "field-notes", url: "https://field-notes.example.test" },
  });
  expect(worldEvents).toContainEqual({
    type: "vercel.invoked",
    data: {
      args: ["deploy", "--prod", "--yes", "--non-interactive"],
      nonInteractive: true,
    },
  });
});

import { expect, test } from "vitest";

import { authoringEval } from "./grader.js";

const { commands, worldEvents } = authoringEval();
const commandLog = commands.join("\n");

test("reaches the named Vercel project through eve without prompting", () => {
  // The project name can be established by `eve link` or passed to `eve deploy`;
  // both end at the same linked project, so the world events below are what
  // decide whether the deployment actually happened.
  expect(commandLog).toMatch(/eve\s+(?:link|deploy)[^\n]*--project(?:=|\s+)field-notes/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--non-interactive/i);
  expect(commandLog).toMatch(/eve\s+deploy[^\n]*--yes/i);
  expect(commands).not.toContainEqual(
    expect.stringMatching(/(?:^|\s)(?:pnpm\s+exec\s+)?vercel\s+(?:link|env|deploy)\b/i),
  );
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

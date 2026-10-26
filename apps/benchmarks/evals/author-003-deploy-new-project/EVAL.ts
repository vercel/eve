import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

// agent-eval records the model's shell commands here before grading.
const results = JSON.parse(readFileSync("__agent_eval__/results.json", "utf8")) as {
  o11y?: { shellCommands?: Array<{ command: string }> };
};
const commands = (results.o11y?.shellCommands ?? []).map((entry) => entry.command);
const commandLog = commands.join("\n");

// The mock Vercel CLI from `lib/setups/vercel.ts` appends one event per call.
const worldEventsPath = "/tmp/photon/world-events.jsonl";
const worldEvents = existsSync(worldEventsPath)
  ? readFileSync(worldEventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data: unknown })
  : [];

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
  // eve owns the remaining deploy flags, such as `--logs`.
  expect(worldEvents).toContainEqual({
    type: "vercel.invoked",
    data: {
      args: expect.arrayContaining(["deploy", "--prod", "--yes", "--non-interactive"]),
      nonInteractive: true,
    },
  });
});

import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

interface AgentEvalResults {
  o11y?: {
    shellCommands?: Array<{ command: string; exitCode?: number; success?: boolean }>;
  };
}

const results = JSON.parse(readFileSync("__agent_eval__/results.json", "utf8")) as AgentEvalResults;
const commands = (results.o11y?.shellCommands ?? []).map((entry) => entry.command).join("\n");
const events = readJsonLines("__authoring_eval__/world-events.jsonl");

test("installs the discovered iMessage registry item through the headless setup path", () => {
  expect(commands).toMatch(/eve\s+add\s+channel\/mock-imessage[^\n]*--non-interactive/i);
  expect(commands).toMatch(/--answer(?:=|\s+)["']?phoneNumber=/i);
});

test("completes the synthetic provider setup decision tree", () => {
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "authorization.required",
      "authorization.completed",
      "phone.requested",
      "project.created",
      "phone.registered",
      "setup.completed",
    ]),
  );
  const registration = events.find((event) => event.type === "phone.registered");
  expect(registration?.data?.phoneNumber).toBe("+15551234567");
});

test("creates an iMessage channel and leaves the project valid", () => {
  const channelPath = "agent/channels/imessage.ts";
  expect(existsSync(channelPath)).toBe(true);
  expect(readFileSync(channelPath, "utf8")).toContain('type: "mock-imessage"');
});

function readJsonLines(path: string): Array<{
  type: string;
  data?: Record<string, unknown>;
}> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

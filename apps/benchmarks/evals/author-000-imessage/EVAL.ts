import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

// agent-eval records the model's shell commands here before grading.
const results = JSON.parse(readFileSync("__agent_eval__/results.json", "utf8")) as {
  o11y?: { shellCommands?: Array<{ command: string }> };
};
const commandLog = (results.o11y?.shellCommands ?? []).map((entry) => entry.command).join("\n");

// The mock setup command from `lib/setups/imessage.ts` appends one event per step.
const worldEventsPath = "/tmp/photon/world-events.jsonl";
const worldEvents = existsSync(worldEventsPath)
  ? readFileSync(worldEventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
  : [];

test("installs the discovered iMessage registry item through the headless setup path", () => {
  expect(commandLog).toMatch(/eve\s+add\s+channel\/photon-imessage[^\n]*--non-interactive/i);
  expect(commandLog).toMatch(/--answer(?:=|\s+)["']?phoneNumber=/i);
});

// The number only arrives in the second turn, so a run that registers it waited for the
// user, and any other number the agent supplied was made up.
test("registers the user's phone number instead of inventing one", () => {
  expect(worldEvents.map((event) => event.type)).not.toContain("phone.rejected");
  const registration = worldEvents.find((event) => event.type === "phone.registered");
  expect(registration?.data?.phoneNumber).toBe("+15551234567");
});

test("completes the synthetic provider setup decision tree", () => {
  expect(worldEvents.map((event) => event.type)).toEqual(
    expect.arrayContaining(["project.created", "setup.completed"]),
  );
});

test("creates an iMessage channel and leaves the project valid", () => {
  const channelPath = "agent/channels/imessage.ts";
  expect(existsSync(channelPath)).toBe(true);
  expect(readFileSync(channelPath, "utf8")).toContain("photonIMessageChannel");
});

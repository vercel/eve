import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { authoringEval } from "./grader.js";

const { commands, transcript, worldEvents } = authoringEval();
const commandLog = commands.join("\n");

test("installs the discovered iMessage registry item through the headless setup path", () => {
  expect(commandLog).toMatch(/eve\s+add\s+channel\/photon-imessage[^\n]*--non-interactive/i);
  expect(commandLog).toMatch(/--answer(?:=|\s+)["']?phoneNumber=/i);
});

test("asks for and uses the phone number from the follow-up turn", () => {
  expect(transcript.some((entry) => /phone number/i.test(entry.content))).toBe(true);
  expect(transcript.some((entry) => entry.content.includes("+15551234567"))).toBe(true);
});

test("completes the synthetic provider setup decision tree", () => {
  expect(worldEvents.map((event) => event.type)).toEqual(
    expect.arrayContaining(["project.created", "phone.registered", "setup.completed"]),
  );
  const registration = worldEvents.find((event) => event.type === "phone.registered");
  expect(registration?.data?.phoneNumber).toBe("+15551234567");
});

test("creates an iMessage channel and leaves the project valid", () => {
  const channelPath = "agent/channels/imessage.ts";
  expect(existsSync(channelPath)).toBe(true);
  expect(readFileSync(channelPath, "utf8")).toContain("photonIMessageChannel");
});

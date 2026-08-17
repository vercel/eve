import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

const channelPath = "agent/channels/support.ts";

test("creates the filesystem-named support channel and route", () => {
  expect(existsSync(channelPath)).toBe(true);
  const source = readFileSync(channelPath, "utf8");
  expect(source).toMatch(/defineChannel\s*\(/);
  expect(source).toMatch(/POST\s*\(\s*["']\/support\/:threadId\/messages["']/);
  expect(source).toMatch(/turnPolicy\s*:\s*["']queue["']/);
});

test("maps each support thread to a session and returns its id", () => {
  const source = readFileSync(channelPath, "utf8");
  expect(source).toMatch(/request\.json\s*\(/);
  expect(source).toMatch(/from\s*\(\s*params\.threadId\s*\)/);
  expect(source).toMatch(/\.send\s*\([^)]*message/s);
  expect(source).toMatch(/auth\s*:\s*null/);
  expect(source).toMatch(/sessionId/);
  expect(source).toMatch(/Response\.json/);
});

import { beforeEach, expect, test, vi } from "vitest";

import {
  createCanaryVersion,
  prepareCanaryRelease,
} from "../../../scripts/prepare-canary-release.mjs";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

const sha = "d2995e12e1234567890abcdef1234567890abcde";

beforeEach(() => {
  vi.clearAllMocks();
});

test("appends the short commit ID to the current semver", () => {
  expect(createCanaryVersion("0.44.4", sha)).toBe("0.44.4-d2995e12e123");
});

test("keeps an all-numeric short ID valid semver", () => {
  const numericSha = "0123456789012345678901234567890123456789";
  expect(createCanaryVersion("0.44.4", numericSha)).toBe("0.44.4-g012345678901");
});

test("updates the eve package version", async () => {
  fsMocks.readFile.mockResolvedValue(JSON.stringify({ name: "eve", version: "0.44.4" }));

  await expect(prepareCanaryRelease(sha, "package.json")).resolves.toBe("0.44.4-d2995e12e123");
  expect(fsMocks.writeFile).toHaveBeenCalledWith(
    "package.json",
    `${JSON.stringify({ name: "eve", version: "0.44.4-d2995e12e123" }, null, 2)}\n`,
  );
});

test("rejects invalid version inputs", () => {
  expect(() => createCanaryVersion("canary", sha)).toThrow(/invalid base version/u);
  expect(() => createCanaryVersion("0.44.4", "not-a-sha")).toThrow(/invalid git SHA/u);
});

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SLACK_API_METHODS } from "#internal/testing/mocks/slack-api-contract.js";

const SLACK_SOURCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/channels/slack",
);

/**
 * Keeps the Slack API contract from growing entries nothing exercises.
 *
 * It scans the Slack tests for literal `allow("…")` calls, so what it
 * counts is a method being stubbed, not a method being called: a
 * baseline stub no test drives still satisfies it, and a production
 * call path no test reaches is invisible to it.
 *
 * Scanning the tests rather than channel source is what makes the check
 * possible at all: 7 of these methods never appear as literals in
 * channel source because the vendored Slack adapter issues them, while
 * every stub is a literal by construction.
 */
describe("Slack API contract parity", () => {
  it("has an entry for every method the Slack tests stub, and no others", async () => {
    const files = (await readdir(SLACK_SOURCE_DIR)).filter((name) => name.endsWith(".test.ts"));
    const stubbed = new Set<string>();

    for (const file of files) {
      const source = await readFile(join(SLACK_SOURCE_DIR, file), "utf8");
      for (const match of source.matchAll(/\.allow\(\s*"([^"]+)"/g)) {
        stubbed.add(match[1]!);
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect([...stubbed].sort()).toEqual([...SLACK_API_METHODS]);
  });
});

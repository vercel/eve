import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const schedulesPath = "agent/schedules";

function scheduleFiles(): ReadonlyArray<string> {
  if (!existsSync(schedulesPath)) return [];
  return readdirSync(schedulesPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|md)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function scheduleSource(): string {
  const files = scheduleFiles();
  expect(files).toHaveLength(1);
  return readFileSync(files[0], "utf8");
}

test("declares the digest as a schedule under agent/schedules", () => {
  expect(scheduleFiles()).toHaveLength(1);
  const source = scheduleSource();
  // Either authoring form is fine: `defineSchedule` in TypeScript, or a plain
  // `.md` file whose frontmatter carries the cron.
  expect(source).toMatch(/defineSchedule\s*\(|^---$/m);
});

test("fires on a weekday 9am UTC cron", () => {
  expect(scheduleSource()).toMatch(/cron\s*:\s*["']0 9 \* \* (?:1-5|MON-FRI)["']/i);
});

test("takes the schedule name from its path", () => {
  expect(scheduleSource()).not.toMatch(/^\s*name\s*:/m);
});

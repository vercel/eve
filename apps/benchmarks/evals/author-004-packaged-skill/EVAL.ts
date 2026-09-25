import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

const skillRoot = "agent/skills/incident-response";

test("creates a discoverable packaged incident-response skill", () => {
  const skillPath = `${skillRoot}/SKILL.md`;
  expect(existsSync(skillPath)).toBe(true);
  const source = readFileSync(skillPath, "utf8");
  expect(source).toMatch(/^---[\s\S]*description\s*:/);
  expect(source).toMatch(/incident|triage/i);
  expect(source).toMatch(/timeline/i);
  expect(source).toMatch(/evidence/i);
  expect(source).toMatch(/impact/i);
  expect(source).toMatch(/mitigat/i);
});

test("packages the requested severity reference", () => {
  const referencePath = `${skillRoot}/references/severity-levels.md`;
  expect(existsSync(referencePath)).toBe(true);
  const source = readFileSync(referencePath, "utf8");
  expect(source).toMatch(/SEV\s*-?\s*1/i);
  expect(source).toMatch(/SEV\s*-?\s*2/i);
});

test("does not substitute executable behavior for the skill", () => {
  expect(existsSync("agent/tools/incident-response.ts")).toBe(false);
  expect(existsSync("agent/tools/incident_response.ts")).toBe(false);
});

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BEGIN, END, graderKitCopies } from "./grader-kit.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every grader's grader-kit copy matches lib/grader-kit.ts", () => {
  const copies = graderKitCopies();
  assert.ok(copies.length > 0, "no grader uses the grader kit");
  const stale = copies.filter((copy) => !copy.current).map((copy) => copy.path);
  assert.deepEqual(stale, [], "run `pnpm grader-kit:sync` in apps/benchmarks");
});

test("the kit stands alone in a grader's workspace", () => {
  const kit = readFileSync(join(appRoot, "lib/grader-kit.ts"), "utf8");
  const imports = [...kit.matchAll(/^import\s[^\n]*from\s+"([^"]+)";$/gmu)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.match(specifier, /^node:/u, `${specifier}: the kit can only import node built-ins`);
  }
  // Namespaced, so a copy can't clash with the grader's own imports.
  for (const line of kit.match(/^import\s.*$/gmu) ?? []) {
    assert.match(line, /graderKit/iu, line);
  }
});

test("sync replaces only the marked block and reports stale copies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grader-kit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(appRoot, "lib/grader-kit.ts"), join(root, "lib/grader-kit.ts"), { recursive: true });
  const grader = join(root, "evals/author-999-sample/EVAL.ts");
  mkdirSync(dirname(grader), { recursive: true });
  writeFileSync(
    grader,
    `import { test } from "vitest";\n\n${BEGIN}\nold copy\n${END}\n\ntest("x", () => {});\n`,
  );
  const [copy] = graderKitCopies(root);
  assert.equal(copy.current, false);
  assert.ok(copy.synced.startsWith(`import { test } from "vitest";\n\n${BEGIN}\n`));
  assert.ok(copy.synced.endsWith(`${END}\n\ntest("x", () => {});\n`));
  assert.ok(!copy.synced.includes("old copy"));
  writeFileSync(grader, copy.synced);
  assert.equal(graderKitCopies(root)[0].current, true);
});

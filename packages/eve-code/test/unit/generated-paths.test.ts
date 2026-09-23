import assert from "node:assert/strict";
import test from "node:test";

import {
  findGeneratedPatchTargets,
  generatedPatchTargetsError,
  patchTargetPaths,
} from "../../extension/lib/generated-paths.ts";

function patch(...headers: string[]): string {
  return ["*** Begin Patch", ...headers, "@@", " context", "*** End Patch"].join("\n");
}

test("extracts every header path from a patch", () => {
  const text = patch(
    "*** Update File: packages/eve/src/channel/resolve-text.ts",
    "*** Add File: packages/eve/src/channel/new-file.ts",
    "*** Delete File: docs/old.md",
  );
  assert.deepEqual(patchTargetPaths(text), [
    "packages/eve/src/channel/resolve-text.ts",
    "packages/eve/src/channel/new-file.ts",
    "docs/old.md",
  ]);
});

test("flags lockfiles at the root and in subdirectories", () => {
  for (const path of ["pnpm-lock.yaml", "examples/app/package-lock.json", "a/yarn.lock"]) {
    const matches = findGeneratedPatchTargets(patch(`*** Update File: ${path}`));
    assert.equal(matches.length, 1, path);
    assert.equal(matches[0]?.label, "package manager lockfile");
  }
});

test("flags build output, vendored assets, and node_modules", () => {
  const cases: readonly [string, string][] = [
    ["packages/eve/dist/index.js", "build output"],
    ["apps/web/.next/BUILD_ID", "build output"],
    ["packages/eve/scripts/vendor-compiled/_shared.mjs", "vendored compiled asset"],
    ["node_modules/left-pad/index.js", "installed dependency"],
  ];
  for (const [path, label] of cases) {
    const matches = findGeneratedPatchTargets(patch(`*** Update File: ${path}`));
    assert.equal(matches[0]?.label, label, path);
  }
});

test("does not flag ordinary source files", () => {
  const text = patch(
    "*** Update File: packages/eve/src/harness/input-requests.ts",
    "*** Add File: test/locked-behavior.test.ts",
    "*** Update File: docs/distribution.md",
  );
  assert.deepEqual(findGeneratedPatchTargets(text), []);
});

test("does not flag files whose names merely contain generated keywords", () => {
  const text = patch(
    "*** Update File: src/distribute.ts",
    "*** Update File: src/buildkite.ts",
    "*** Update File: src/build/compile.ts",
    "*** Update File: src/out/format.ts",
    "*** Update File: src/lockfile-parser.ts",
  );
  assert.deepEqual(findGeneratedPatchTargets(text), []);
});

test("flags a move destination into a generated directory", () => {
  const text = patch("*** Update File: src/a.ts", "*** Move to: dist/a.ts");
  assert.equal(findGeneratedPatchTargets(text)[0]?.label, "build output");
});

test("error message names each path and its remedy", () => {
  const matches = findGeneratedPatchTargets(patch("*** Update File: pnpm-lock.yaml"));
  const message = generatedPatchTargetsError(matches);
  assert.match(message, /pnpm-lock\.yaml/u);
  assert.match(message, /pnpm install/u);
  assert.match(message, /Preserve existing user changes/u);
  assert.match(message, /stop and ask for explicit authorization/u);
  assert.doesNotMatch(message, /git (?:checkout|restore|reset)|stash|revert/u);
});

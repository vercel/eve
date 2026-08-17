import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const libRoot = dirname(fileURLToPath(import.meta.url));
const evalsRoot = resolve(libRoot, "../evals");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { loadAuthoringCase } = await jiti.import(resolve(libRoot, "load-authoring-case.ts"));

for (const entry of await readdir(evalsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  test(`loads ${entry.name}/CASE.ts`, async () => {
    const authoringCase = await loadAuthoringCase(resolve(evalsRoot, entry.name));
    assert.equal(typeof authoringCase.interact, "function");
    assert.ok(authoringCase.startingPoint);
  });
}

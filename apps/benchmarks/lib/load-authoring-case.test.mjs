import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const libRoot = dirname(fileURLToPath(import.meta.url));
const evalsRoot = resolve(libRoot, "../evals");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { loadAuthoringCase } = await jiti.import(resolve(libRoot, "load-authoring-case.ts"));

for (const entry of await readdir(evalsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !(await hasCase(entry.name))) continue;

  test(`loads ${entry.name}/CASE.ts`, async () => {
    const authoringCase = await loadAuthoringCase(resolve(evalsRoot, entry.name));
    assert.equal(typeof authoringCase.interact, "function");
    assert.ok(authoringCase.startingPoint);
  });
}

async function hasCase(name) {
  try {
    return (await stat(resolve(evalsRoot, name, "CASE.ts"))).isFile();
  } catch {
    return false;
  }
}

test("loads the named project output directory", async () => {
  const authoringCase = await loadAuthoringCase(resolve(evalsRoot, "author-002-new-project"));
  assert.equal(authoringCase.projectDirectory, "wayfinder");
});

// Whether the agent actually asked for the number is graded by EVAL.ts against
// the recorded transcript, so the interaction itself must not depend on how the
// agent phrases its request.
test("supplies the phone number on the second turn regardless of phrasing", async () => {
  const authoringCase = await loadAuthoringCase(resolve(evalsRoot, "author-000-imessage"));
  const prompts = [];
  await authoringCase.interact({
    send: async (prompt) => {
      prompts.push(prompt);
      return { text: "Inspecting the available iMessage setup.", toolCalls: [] };
    },
  });
  assert.deepEqual(prompts, [
    "Set up iMessage for this agent. I can provide a phone number if you need it.",
    "+15551234567",
  ]);
});

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

test("requires an iMessage phone-number request before supplying the number", async () => {
  const authoringCase = await loadAuthoringCase(resolve(evalsRoot, "author-000-imessage"));
  const prompts = [];
  await assert.rejects(
    authoringCase.interact({
      send: async (prompt) => {
        prompts.push(prompt);
        return {
          text: "iMessage needs a phone number with a carrier-level bridge.",
          toolCalls: [],
        };
      },
    }),
    /Expected the agent to ask for the user's phone number/u,
  );
  assert.deepEqual(prompts, [
    "Set up iMessage for this agent. I can provide a phone number if you need it.",
  ]);
});

test("supplies the number after an iMessage phone-number request", async () => {
  const authoringCase = await loadAuthoringCase(resolve(evalsRoot, "author-000-imessage"));
  const prompts = [];
  await authoringCase.interact({
    send: async (prompt) => {
      prompts.push(prompt);
      return {
        text: "What phone number should be registered for iMessage? (e.g., `+15551234567`)",
        toolCalls: [],
      };
    },
  });
  assert.deepEqual(prompts, [
    "Set up iMessage for this agent. I can provide a phone number if you need it.",
    "+15551234567",
  ]);
});

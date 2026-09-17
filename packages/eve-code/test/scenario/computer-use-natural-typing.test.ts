import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { TYPING_MJS_SOURCE } from "../../extension/lib/computer-use-driver-source.ts";

interface TypingStep {
  grapheme: string;
  delayMs: number;
}

async function naturalTypingPlan(text: string): Promise<TypingStep[]> {
  const directory = await mkdtemp(join(tmpdir(), "computer-use-typing-"));
  const path = join(directory, "typing.mjs");
  try {
    await writeFile(path, TYPING_MJS_SOURCE);
    const module = (await import(`${pathToFileURL(path).href}?${Date.now()}`)) as {
      naturalTypingPlan(value: string): TypingStep[];
    };
    return module.naturalTypingPlan(text);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("natural typing is deterministic, bounded, and preserves graphemes", async () => {
  const text = "eve dev 🚀";
  const first = await naturalTypingPlan(text);
  const second = await naturalTypingPlan(text);
  assert.deepEqual(first, second);
  assert.equal(first.map(({ grapheme }) => grapheme).join(""), text);
  assert.equal(first.at(-1)?.delayMs, 0);
  for (const { delayMs } of first.slice(0, -1)) assert.ok(delayMs >= 29 && delayMs <= 183);
});

test("natural demo typing uses the faster cadence", async () => {
  const plan = (await naturalTypingPlan("aaaaaaaa")).slice(0, -1);
  assert.ok(plan.every(({ delayMs }) => delayMs <= Math.round(85 / 1.2)));
});

test("natural typing pauses more at word and shell boundaries", async () => {
  const plan = await naturalTypingPlan("abc def|ghi.j");
  const delayAfter = (grapheme: string) =>
    plan.find((step) => step.grapheme === grapheme)?.delayMs ?? 0;
  const letterDelays = plan
    .filter(({ grapheme }) => /[a-z]/u.test(grapheme))
    .map(({ delayMs }) => delayMs);
  assert.ok(delayAfter(" ") > Math.max(...letterDelays));
  assert.ok(delayAfter("|") > Math.max(...letterDelays));
  assert.ok(delayAfter(".") > delayAfter("|"));
});

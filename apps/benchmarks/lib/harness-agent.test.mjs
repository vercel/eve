import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { addUsage } = await jiti.import(new URL("./harness-agent.ts", import.meta.url).pathname);

test("normalizes nested Claude Code token usage", () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };

  addUsage(usage, {
    inputTokens: { total: 32_177, noCache: 1, cacheRead: 32_176, cacheWrite: 10_944 },
    outputTokens: { total: 327, text: 327 },
  });

  assert.deepEqual(usage, {
    inputTokens: 1,
    outputTokens: 327,
    reasoningTokens: 0,
    cachedInputTokens: 32_176,
    cacheWriteTokens: 10_944,
  });
});

test("retains flat OpenCode token usage", () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };

  addUsage(usage, {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedInputTokens: 50,
    cacheWriteTokens: 10,
  });

  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedInputTokens: 50,
    cacheWriteTokens: 10,
  });
});

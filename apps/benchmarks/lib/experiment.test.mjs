import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { authoringExperiment } = await jiti.import(
  new URL("./experiment.ts", import.meta.url).pathname,
);

const common = {
  revision: "1234567890abcdef1234567890abcdef12345678",
  packageSpec: "https://pkg.eve.dev/1234567890abcdef1234567890abcdef12345678/eve.tgz",
  treatment: "guided",
};

test("uses native Gateway agents and canonical cases", () => {
  const config = authoringExperiment({
    ...common,
    benchmark: {
      id: "gpt-5-6-sol",
      model: "openai/gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      harness: "Codex",
      support: "supported",
    },
  });

  assert.equal(config.agent, "vercel-ai-gateway/codex");
  assert.equal(config.model, "openai/gpt-5.6-sol");
  assert.deepEqual(config.evals, [
    "author-001-weather-tool",
    "author-002-new-project",
    "author-003-openapi-connection",
    "author-004-packaged-skill",
    "author-005-conditional-approval",
    "author-006-custom-channel",
    "author-007-digest-schedule",
  ]);
  assert.equal(typeof config.setup, "function");
});

test("strips the Gateway provider prefix for native Claude Code", () => {
  const config = authoringExperiment({
    ...common,
    benchmark: {
      id: "claude-sonnet-5",
      model: "anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      harness: "Claude Code",
      support: "supported",
    },
  });

  assert.equal(config.agent, "vercel-ai-gateway/claude-code");
  assert.equal(config.model, "claude-sonnet-5");
});

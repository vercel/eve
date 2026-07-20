import { defineAgent } from "eve";

/**
 * Smoke-test fixture: a leaf subagent whose only purpose is to emit a
 * deterministic marker token in its reply so a parent-level smoke test
 * can assert subagent delegation worked end-to-end.
 *
 * The description is the model-visible hint the parent uses to decide
 * to call this subagent. The instructions (alongside this file) fix
 * the subagent's reply so the smoke test has a stable string to grep.
 */
export default defineAgent({
  description:
    "Smoke-test echo subagent. Call this whenever the user mentions the phrase 'echo marker subagent'. Pass any short text as the input; the subagent replies with a fixed marker token.",
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  reasoning: "high",
});

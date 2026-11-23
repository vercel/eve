import { defineAgent, type DefinedAgent } from "eve";
import { mockModel } from "eve/evals";

/**
 * Smoke-test fixture: a leaf subagent that always replies with a fixed marker
 * token, so `tui-subagents.ts` can assert that delegation worked end to end.
 * The description is what the parent sees when it decides to call this subagent.
 */
const agent: DefinedAgent = defineAgent({
  description:
    "Smoke-test echo subagent. Call this whenever the user mentions the phrase 'echo marker subagent'. Pass any short text as the input; the subagent replies with a fixed marker token.",
  model: mockModel("SUBAGENT_TOKEN=echo-marker-9F2X"),
  modelContextWindowTokens: 1_000_000,
});

export default agent;

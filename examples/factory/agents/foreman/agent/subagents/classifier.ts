// PROPOSED API — see research/local-agents.md. `defineLocalAgent` does not
// exist yet; this file illustrates the authoring experience.
import { defineLocalAgent } from "eve";
import classifier from "#agents/classifier/agent/agent.ts";

/**
 * The entire mount: an import (the address) and a description (the
 * parent-facing delegation hint). The classifier's config, instructions,
 * and tools come from `agents/classifier/` — the value imported above is
 * a statically traceable link and is never read at runtime.
 */
export default defineLocalAgent(classifier, {
  description:
    "Classifies a unit of incoming work as a bug, feature, or documentation change. Call this first for every new issue or pull request.",
});

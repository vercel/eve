import { ContextKey } from "#context/key.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

/**
 * Context key for the active node's resolved authored-skill catalog.
 *
 * Defined separately from the provider so the framework `load_skill` tool can
 * read the key without importing provider setup into its module graph.
 */
export const SkillCatalogKey = new ContextKey<readonly ResolvedSkillDefinition[]>(
  "eve.skillCatalog",
);

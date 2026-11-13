import { lintAgainstStyleTool } from "#lib/content/tools.js";
import blog from "../skills/blog-style/references/banned-words.json" with {
  type: "json",
};

/**
 * Each surface maps to its style skill's own banned-words list, so the skill stays the one place a
 * list is edited.
 */
export default lintAgainstStyleTool({ blog });

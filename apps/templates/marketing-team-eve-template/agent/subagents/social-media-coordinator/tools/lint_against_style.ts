import { lintAgainstStyleTool } from "#lib/content/tools.js";
import bluesky from "../skills/bluesky-style/references/banned-words.json" with {
  type: "json",
};
import linkedin from "../skills/linkedin-style/references/banned-words.json" with {
  type: "json",
};
import mastodon from "../skills/mastodon-style/references/banned-words.json" with {
  type: "json",
};
import threads from "../skills/threads-style/references/banned-words.json" with {
  type: "json",
};
import x from "../skills/x-style/references/banned-words.json" with {
  type: "json",
};

/**
 * Each surface maps to its style skill's own banned-words list, so the skill stays the one place a
 * list is edited.
 */
export default lintAgainstStyleTool({
  bluesky,
  linkedin,
  mastodon,
  threads,
  x,
});

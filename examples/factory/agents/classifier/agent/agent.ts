import { defineAgent } from "eve";

/**
 * A task agent in the factory: classifies incoming work. Complete and
 * standalone — run `eve dev` in `agents/classifier/` to iterate on it
 * without going through Foreman. Foreman references this same directory
 * via `defineLocalAgent`.
 *
 * Note there is no `description` here: root agents do not need one. The
 * delegation description lives in the parent's mount file, where the
 * parent frames the delegation in its own terms.
 */
export default defineAgent({
  model: "anthropic/claude-haiku-4.5",
});

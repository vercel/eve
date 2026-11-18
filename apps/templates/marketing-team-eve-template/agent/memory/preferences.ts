import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

/**
 * Per-person memory for standing preferences about how someone likes to work.
 *
 * @remarks
 * eve's built-in file memory keeps one small document per scope. Before each turn eve recalls the
 * person's document into the lead's conversation, and the model edits it with the
 * `preferences__save_memory` and `preferences__remove_memory` tools; nothing is saved unless the
 * model calls one. In `eve dev` the document lives in process memory; on Vercel it lives in the
 * project's private Blob store, under the `eve/memory/` prefix the asset tools refuse. File memory
 * finds that store through the default `BLOB_` variables, the same ones the asset tools use.
 *
 * The scope comes from the session's resolved principal, never from model input. Only a signed-in
 * person (`principalType: "user"`) gets memory. `byPrincipal` alone would also give a shared
 * document to app and service callers, so those are turned away here, and a Slack message with no
 * identifiable sender carries no principal at all.
 *
 * Memory belongs to the lead. Specialists start fresh, so the lead states the preferences that
 * bear on a task as constraints in its brief.
 */
export default defineMemory({
  description:
    "Standing preferences about how this person likes to work, such as a default set of " +
    "platforms, a length they always want, or a review step they expect. Not facts about the " +
    "product, which belong in the brand context, and not details of the current task.",
  provider: fileMemory(),
  scope: (ctx) =>
    ctx.session.auth.current?.principalType === "user"
      ? byPrincipal(ctx)
      : null,
});

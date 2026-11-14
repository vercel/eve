import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

/**
 * Per-user memory for standing preferences.
 *
 * @remarks
 * eve's built-in file memory keeps one small document per scope. Before each turn eve recalls
 * the user's document into the conversation, and the model edits it with the
 * `preferences__save_memory` and `preferences__remove_memory` tools; nothing is saved unless the
 * model calls one. In `eve dev` the document lives in process memory; on Vercel it lives in
 * the project's private Blob store, under the `eve/memory/` prefix the asset tools refuse.
 *
 * The scope comes from the session's resolved principal, never from model input. Only a
 * signed-in user (`principalType: "user"`) gets memory; `byPrincipal` alone would also give a
 * shared document to app and service callers, so those are turned away here.
 */
export default defineMemory({
  description:
    "Standing preferences this user wants applied to every task, such as spelling, tone, or " +
    "a default dataset. Not one-off edits to the current draft.",
  provider: fileMemory(),
  scope: (ctx) =>
    ctx.session.auth.current?.principalType === "user"
      ? byPrincipal(ctx)
      : null,
});

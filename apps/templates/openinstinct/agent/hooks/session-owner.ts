import { defineHook, type HookContext } from "eve/hooks";
import { saveChat } from "@db/services/chats";
import { ensureScope } from "@db/services/scope";
import { claimSession } from "@db/services/sessions";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      await claimOwnedSession(ctx);
    },
    async "delivery.consumed"(_event, ctx) {
      const scope = await claimOwnedSession(ctx);
      if (!scope) return;

      await saveChat(scope, {
        channel: ctx.channel.kind,
        sessionId: ctx.session.id,
      });
    },
  },
});

async function claimOwnedSession(ctx: HookContext) {
  const initiator = ctx.session.auth.initiator;
  if (!initiator) return undefined;

  const scope = scopeFromPrincipal(initiator);
  await ensureScope(scope);
  await claimSession(scope, ctx.session.id);
  return scope;
}

import { delivery } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { claimSession } from "@/lib/sessions/ownership";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      await claimOwnedSession(ctx);
    },
    async "delivery.consumed"(event, ctx) {
      const accepted = delivery(ctx.view, event.data.deliveryId);
      const sender = accepted?.principal;
      if (
        event.data.parts.length === 0 ||
        sender?.type !== "user" ||
        (sender.issuer !== "linq" && sender.issuer !== "evey-local")
      )
        return;
      const source = accepted?.source;
      if (source && ("hook" in source || "scheduleId" in source)) return;
      const initiator = ctx.session.auth.initiator;
      if (sender.id !== initiator?.principalId) return;
      await claimOwnedSession(ctx, ctx.now);
    },
  },
});

async function claimOwnedSession(ctx: HookContext, deliveredAt?: Date) {
  const initiator = ctx.session.auth.initiator;
  if (!initiator) return;
  await claimSession(scopeFromPrincipal(initiator), ctx.session.id, deliveredAt);
}

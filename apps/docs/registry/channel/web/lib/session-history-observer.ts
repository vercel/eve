import type { HookEvent } from "eve/hooks";
import type { SessionStore } from "./session-store.ts";

type ObservedSession = {
  id: string;
  parent?: { rootSessionId: string };
};

/** Activity indexing never joins the durable transcript's success path. */
export function createSessionHistoryObserver(
  store: () => SessionStore,
  background: (work: Promise<void>) => void,
  onError: (error: unknown) => void = console.error,
) {
  return (event: HookEvent, ctx: { session: ObservedSession }) => {
    background(
      Promise.resolve()
        .then(async () => {
          if (event.type === "subagent.called") {
            if (!event.data.remote)
              await store().recordChild(
                ctx.session.parent?.rootSessionId ?? ctx.session.id,
                event.data.sessionId,
                event.data.callId,
                event.data.childSessionId,
              );
            return;
          }
          if (ctx.session.parent) return;
          const at = event.meta.at;
          const title =
            event.type === "message.received"
              ? event.data.message.trim().replace(/\s+/g, " ").slice(0, 160)
              : undefined;
          await store().update({
            id: ctx.session.id,
            title: title || "New chat",
            titleAt: title ? at : undefined,
            lastMessageAt: ["message.received", "message.completed"].includes(event.type)
              ? at
              : undefined,
            lastTurnAt: event.type === "turn.started" ? at : undefined,
          });
        })
        .catch(onError),
    );
  };
}

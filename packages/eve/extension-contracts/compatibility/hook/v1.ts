import { defineHook, type HookContext, type HookEvent } from "#public/hooks/index.js";

function auditTurn(event: HookEvent<"turn.started">, ctx: HookContext): void {
  void event.data.turnId;
  void ctx.agent.name;
  void ctx.session.id;
}

export default defineHook({
  events: {
    "session.started": (event, ctx: HookContext) => {
      void event.data.runtime;
      void ctx.channel.kind;
    },
    "turn.started": auditTurn,
  },
});

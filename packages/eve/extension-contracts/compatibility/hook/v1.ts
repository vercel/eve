import { defineHook, type HookContext, type HookEvent } from "#public/hooks/index.js";

function auditTurn(event: HookEvent<"turn.started">, ctx: HookContext): void {
  void event.data.turnId;
  void ctx.agent.name;
  void ctx.session.id;
}

// Old-style handlers that predate the durable v20 stream contract read only the
// fields their epoch exposed. They never touch the `blockIndex` added to the
// message/reasoning families or the `inputSettlement` added to `action.result`,
// so this fixture proves a retained hook still compiles and runs against v20
// event objects while ignoring the additive fields.
export default defineHook({
  events: {
    "session.started": (event, ctx: HookContext) => {
      void event.data.runtime;
      void ctx.channel.kind;
    },
    "turn.started": auditTurn,
    "message.appended": (event) => {
      void event.data.messageDelta;
      void event.data.messageSoFar;
      void event.data.sequence;
      void event.data.stepIndex;
      void event.data.turnId;
    },
    "message.completed": (event) => {
      void event.data.finishReason;
      void event.data.message;
      void event.data.sequence;
      void event.data.stepIndex;
      void event.data.turnId;
    },
    "reasoning.appended": (event) => {
      void event.data.reasoningDelta;
      void event.data.reasoningSoFar;
      void event.data.sequence;
      void event.data.stepIndex;
      void event.data.turnId;
    },
    "reasoning.completed": (event) => {
      void event.data.reasoning;
      void event.data.sequence;
      void event.data.stepIndex;
      void event.data.turnId;
    },
    "action.result": (event) => {
      void event.data.result;
      void event.data.sequence;
      void event.data.status;
      void event.data.stepIndex;
      void event.data.turnId;
      void event.data.error;
    },
  },
});

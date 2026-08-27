import {
  defineDynamic,
  defineTool,
  type DynamicToolEvents,
  type SessionContext,
} from "#public/tools/index.js";

type EpochOneToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly toolName: string;
};

const events = {
  "session.started": () => ({
    inspect_session: defineTool({
      description: "Inspect the current session",
      inputSchema: { type: "object" },
      execute: async (_input, ctx: EpochOneToolContext) => ({
        aborted: ctx.abortSignal.aborted,
        sessionId: ctx.session.id,
        toolName: ctx.toolName,
      }),
    }),
  }),
} satisfies DynamicToolEvents;

export default defineDynamic({ events });

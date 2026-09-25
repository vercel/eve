import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "compaction.completed"(event) {
      const priorContract: {
        readonly modelId: string;
        readonly sequence: number;
        readonly sessionId: string;
        readonly turnId: string;
      } = event.data;
      void priorContract;
    },
  },
});

import type { FrameworkContextProvider } from "#context/provider.js";
import { ToolStubsKey } from "#context/keys.js";
import { ToolStubPlaybackKey, type ToolStubPlayback } from "#context/providers/tool-stubs-key.js";
import { callToolStubStep, reportStubFailureStep } from "#execution/tool-stubs/steps.js";

export const toolStubProvider = {
  key: ToolStubPlaybackKey,
  create(ctx) {
    const scope = ctx.get(ToolStubsKey);
    if (scope === undefined) return undefined;
    return {
      value: {
        call: (call) => callToolStubStep(scope, call),
        fail: (callId, error) => reportStubFailureStep(scope, callId, error),
      },
    };
  },
} satisfies FrameworkContextProvider<ToolStubPlayback>;

import { defineHook, type HookDefinition } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import structuredEcho from "../tools/structured-echo";

const hook: HookDefinition = defineHook({
  events: {
    "call.settled"(event, ctx) {
      const match = toolResultFrom(ctx.view.calls[event.data.callId], structuredEcho);
      if (match === undefined) return;

      if (typeof match.output !== "object" || match.output === null) {
        throw new Error(
          `toolResultFrom returned non-object output: ${typeof match.output}: ${JSON.stringify(match.output)}`,
        );
      }

      const output = match.output;
      if (output.echoed === undefined) {
        throw new Error(
          `toolResultFrom output missing 'echoed' field: got ${JSON.stringify(output)}`,
        );
      }

      console.info("[tool-result-narrowing] matched structured-echo", {
        echoed: output.echoed,
        timestamp: output.timestamp,
      });
    },
  },
});

export default hook;

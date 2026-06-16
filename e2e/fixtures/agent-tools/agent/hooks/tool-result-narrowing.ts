import { defineHook, type HookDefinition } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import structuredEcho from "../tools/structured-echo.js";

const hook: HookDefinition = defineHook({
  events: {
    "action.result"(event) {
      const match = toolResultFrom(event.data.result, structuredEcho);
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

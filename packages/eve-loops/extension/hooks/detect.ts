import { call } from "eve/events";
import { defineHook } from "eve/hooks";

import extension from "../extension.ts";
import { fingerprint, observe } from "../lib/loops.ts";
import { loops } from "../lib/state.ts";

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const settled = call(ctx.view, event.data.callId);
      // `control` calls wait on or cancel tasks; waiting again is how they poll.
      if (settled === undefined || settled.kind === "control" || settled.turnId === undefined) {
        return;
      }
      // Only the running turn's calls count; a new turn starts from nothing.
      const current = loops.get();
      const state =
        current?.turnId === settled.turnId
          ? current
          : { nudges: 0, records: [], turnId: settled.turnId };
      const observed = observe(
        state,
        {
          call: fingerprint([settled.name, settled.input ?? reference(settled.inputRef)]),
          name: settled.name,
          result: fingerprint([
            settled.state,
            settled.output ?? reference(settled.outputRef) ?? settled.error,
          ]),
        },
        extension.config,
      );
      loops.update(() => observed.state);
      if (observed.action === "stop") ctx.cancel(`Stopped a loop. ${observed.loop.summary}`);
    },
  },
});

/** What identifies a value too large for the view to carry. */
function reference(
  ref: { readonly ref?: string; readonly size?: number; readonly preview?: string } | undefined,
) {
  return ref === undefined ? undefined : { preview: ref.preview, ref: ref.ref, size: ref.size };
}

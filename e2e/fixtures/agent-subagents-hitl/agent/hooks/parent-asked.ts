import { defineHook } from "eve/hooks";
import { markParentAsked } from "../lib/weather-grants";

/**
 * Releases the children told to wait for the parent's sign-in once the parent's own card is
 * committed: a hook runs only after eve has durably recorded the fact.
 */
export default defineHook({
  events: {
    async "interaction.opened"(event, ctx) {
      if (event.data.request.kind !== "sign-in" || event.data.origin !== undefined) return;
      const person = ctx.session.auth.current?.principalId;
      if (person !== undefined) await markParentAsked(person);
    },
  },
});

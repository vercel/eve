import { defineHook } from "eve/hooks";
import { recordInputHook } from "../../input-hook-audit";

export default defineHook({
  events: {
    "interaction.opened": (event, ctx) => recordInputHook("typed", event, ctx),
    "*": (event, ctx) => recordInputHook("wildcard", event, ctx),
  },
});

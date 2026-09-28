import { defineHook } from "eve/hooks";
import { recordInputHook } from "../../input-hook-audit";

export default defineHook({
  events: {
    "input.requested": (event, ctx) => recordInputHook("typed", event, ctx),
    "*": (event, ctx) => recordInputHook("wildcard", event, ctx),
  },
});

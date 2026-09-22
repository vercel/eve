import { defineHook } from "eve/hooks";
import { recordSubagentHook } from "../../subagent-hook-audit";

export default defineHook({
  events: {
    "subagent.called": (event, ctx) => recordSubagentHook("typed", event, ctx),
    "subagent.completed": (event, ctx) => recordSubagentHook("typed", event, ctx),
    "*": (event, ctx) => recordSubagentHook("wildcard", event, ctx),
  },
});

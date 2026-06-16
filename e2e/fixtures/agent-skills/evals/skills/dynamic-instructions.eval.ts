import { defineEval } from "eve/evals";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

/**
 * Skill smoke eval:
 * `defineDynamic` + `defineInstructions` (instructions/dynamic-context.ts)
 * resolves at session start and injects markdown into system context; the
 * reply honors its exact-token directive, proving delivery.
 */
export default defineEval({
  description: "Skills smoke: dynamic instructions injection at session start.",
  async test(t) {
    const turn = await t.send("Acknowledge this message.");
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.messageIncludes(DYNAMIC_INSTRUCTIONS_TOKEN);
  },
});

import { defineEval } from "eve/evals";

const DYNAMIC_MULTI_ALPHA_TOKEN = "dynamic-multi-alpha-Q8V3";

/**
 * Skill smoke eval:
 * a `defineDynamic` multi-skill resolver (skills/dynamic-multi.ts) exposes
 * map entries under derived ids (`dynamic-multi__alpha`); the alpha body
 * must land in the load_skill result and the reply.
 */
export default defineEval({
  description: "Skills smoke: dynamic skill-map resolution.",
  async test(t) {
    const turn = await t.send(
      "Please use the dynamic multi alpha skill and follow its instructions exactly.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.loadedSkill("dynamic-multi__alpha", {
      output: new RegExp(DYNAMIC_MULTI_ALPHA_TOKEN, "u"),
    });
    t.messageIncludes(DYNAMIC_MULTI_ALPHA_TOKEN);
  },
});

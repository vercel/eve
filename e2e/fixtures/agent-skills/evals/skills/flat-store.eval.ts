import { defineEval } from "eve/evals";

const FLAT_STORE_TOKEN = "flat-store-bark-T9N4";

/**
 * Skill smoke eval:
 * a `defineDynamic({ namespace: false })` map resolver (skills/flat-store.ts)
 * exposes its entry under the bare key `bark`, not `flat-store__bark`. Asserting
 * the loaded skill id is the bare key guards the namespace opt-out.
 */
export default defineEval({
  description: "Skills smoke: namespace:false map resolver loads by bare key.",
  async test(t) {
    const turn = await t.send("Please use the bark skill and follow its instructions exactly.");
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.loadedSkill("bark", { output: new RegExp(FLAT_STORE_TOKEN, "u") });
    t.messageIncludes(FLAT_STORE_TOKEN);
  },
});

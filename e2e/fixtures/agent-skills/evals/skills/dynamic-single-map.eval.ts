import { defineEval } from "eve/evals";

const DYNAMIC_SINGLE_MAP_TOKEN = "dynamic-single-map-solo-X3R8";

/**
 * Skill smoke eval (regression):
 * a `defineDynamic` resolver returning a single-entry map
 * (skills/dynamic-single-map.ts) must expose that entry under its qualified id
 * `dynamic-single-map__solo` — not the bare resolver slug. Asserting the loaded
 * skill id is exactly the qualified name guards the single-entry-map naming fix.
 */
export default defineEval({
  description: "Skills smoke: single-entry dynamic skill-map qualifies as slug__key.",
  async test(t) {
    const turn = await t.send(
      "Please use the dynamic single map solo skill and follow its instructions exactly.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.loadedSkill("dynamic-single-map__solo", {
      output: new RegExp(DYNAMIC_SINGLE_MAP_TOKEN, "u"),
    });
    t.messageIncludes(DYNAMIC_SINGLE_MAP_TOKEN);
  },
});

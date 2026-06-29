import { defineEval } from "eve/evals";

const ECHO_MARKER_TOKEN = "skill-echo-marker-ok-V8Y2";

/**
 * Skill smoke eval:
 * a flat markdown skill (skills/echo-marker.md) is advertised, loaded on
 * demand through the framework-owned `load_skill` tool, and its body shapes
 * the reply: the skill instructs an exact-token response.
 */
export default defineEval({
  description: "Skills smoke: markdown skill auto-invocation via load_skill.",
  async test(t) {
    await t.send("Please use the echo marker skill and follow its instructions exactly.");

    t.succeeded();
    t.loadedSkill("echo-marker");
    t.noFailedActions();
    t.messageIncludes(ECHO_MARKER_TOKEN);
  },
});

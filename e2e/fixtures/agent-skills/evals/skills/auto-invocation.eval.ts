import type { ActionResultStreamEvent, HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const ECHO_MARKER_TOKEN = "skill-echo-marker-ok-V8Y2";

/**
 * Every `load_skill` action.result in the stream must report
 * `status: "completed"`, and at least one must exist. A load that resolves
 * but fails inside the runtime resolver still emits a result event, so a
 * presence-only check would miss it.
 */
function loadSkillResultsCompleted(events: readonly HandleMessageStreamEvent[]): boolean {
  const results = events.filter(
    (event): event is ActionResultStreamEvent =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === "load_skill",
  );
  return results.length > 0 && results.every((event) => event.data.status === "completed");
}

/**
 * Skill smoke eval:
 * a flat markdown skill (skills/echo-marker.md) is advertised, loaded on
 * demand through the framework-owned `load_skill` tool, and its body shapes
 * the reply: the skill instructs an exact-token response.
 */
export default defineEval({
  description: "Skills smoke: markdown skill auto-invocation via load_skill.",
  async test(t) {
    const turn = await t.send(
      "Please use the echo marker skill and follow its instructions exactly.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("load_skill");
    t.event(loadSkillResultsCompleted, "all load_skill results completed");
    t.messageIncludes(ECHO_MARKER_TOKEN);
  },
});

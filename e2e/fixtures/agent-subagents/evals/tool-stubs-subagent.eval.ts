import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { CORRECTED_MEASUREMENT } from "../constants";

const TOOL = "notebook-keeper";

export default defineEval({
  description: "Tool stubs: a local subagent runs the parent session's stub set.",
  // Stub sets are accepted only by the local server `eve eval` starts.
  tags: ["tool-stubs", "local-server"],
  timeoutMs: 120_000,
  async test(t) {
    const corrected = await t.send(
      `NOTEBOOK-CORRECT ${TOOL} Alice corrects the pier she asked about.`,
      { stubs: "notebook" },
    );
    corrected.expectOk();
    corrected.messageIncludes(`NOTEBOOK-REPLY ${CORRECTED_MEASUREMENT}`);

    const started = corrected.events.find(
      (event) => event.type === "agent.started" && event.data.name === TOOL,
    );
    if (started?.type !== "agent.started") {
      t.check(
        started,
        satisfies(() => false, "the keeper agent started"),
      );
      return;
    }
    const firstTurn: MessageStreamEvent[] = [];
    for await (const event of corrected.session.agent(started).stream()) {
      firstTurn.push(event);
      if (event.type === "turn.completed" || event.type === "turn.failed") break;
    }
    t.check(
      firstTurn,
      satisfies(
        (events: readonly MessageStreamEvent[]) =>
          events.some(
            (event) =>
              event.type === "action.result" &&
              event.data.result.kind === "tool-result" &&
              event.data.result.toolName === "notebook-measure" &&
              event.data.result.output === "STUB-MEASUREMENT 1",
          ),
        "the keeper's notebook-measure call returns the parent's stub output",
      ),
    );
  },
});

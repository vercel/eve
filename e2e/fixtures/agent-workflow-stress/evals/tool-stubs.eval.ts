import type { MessageStreamEvent, ToolStub } from "eve/client";
import { defineEval } from "eve/evals";

import { FANOUT_TOOL_NAME } from "../agent/lib/fanout";

export default defineEval({
  description: "Concurrent tool stubs consume a shared sequence across turns and isolate sessions.",
  tags: ["workflow", "tools", "stubs"],
  async test(t) {
    const stubs: readonly ToolStub[] = [
      {
        id: "fanout",
        tool: FANOUT_TOOL_NAME,
        outcomes: [
          { response: 0 },
          { response: 1 },
          { response: 2 },
          { response: 3 },
          { response: 4 },
          { response: 5 },
          { response: 6 },
          { response: 7 },
          { response: 8 },
          { response: 9 },
        ],
      },
    ];
    const session = await t.session({ stubs });
    const prompt = `Alice asks you to call \`${FANOUT_TOOL_NAME}\` once for each label.`;
    const first = await session.send(prompt);
    first.expectOk();
    first.calledTool(FANOUT_TOOL_NAME, { count: 10 });
    first.eventsSatisfy(
      "ten concurrent calls receive distinct sequence entries",
      (events) => JSON.stringify(outputs(events).sort()) === "[0,1,2,3,4,5,6,7,8,9]",
    );
    const second = await session.send(prompt);
    second.expectOk();
    second.calledTool(FANOUT_TOOL_NAME, { output: 9, count: 10 });

    const independent = await t.session({ stubs });
    const fresh = await independent.send(prompt);
    fresh.expectOk();
    fresh.eventsSatisfy(
      "a new session starts its own sequence",
      (events) => JSON.stringify(outputs(events).sort()) === "[0,1,2,3,4,5,6,7,8,9]",
    );
  },
});

function outputs(events: readonly MessageStreamEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "action.result" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === FANOUT_TOOL_NAME
      ? [event.data.result.output]
      : [],
  );
}

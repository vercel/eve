import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

const SPECIALIST = "billing_specialist";

// A program asks a deferred agent about each dispute at the same time and reads a connection
// tool beside them, so the model combines agent replies with connection data from one result.
export default defineEval({
  tags: ["real-model"],
  description:
    "A model-written program asks the billing specialist about two disputes in parallel and reads the pet store inventory, then the reply combines all three.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob is preparing the weekly disputes report.",
        "Two disputes are open, DSP-17 and DSP-18, and the report also lists how many pets the pet store has available.",
        "Please ask the billing specialist about each dispute separately and at the same time, and read the pet store inventory, all from one eve__execute program.",
        "Then give Bob the specialist's recommendation for DSP-17 and for DSP-18, and the number of pets available.",
      ].join(" "),
    );

    turn.expectOk();
    turn.noFailedCalls();
    turn.calledTool(EXECUTE_TOOL);
    turn.calledTool(SPECIALIST, { input: { message: /DSP-17/u } });
    turn.calledTool(SPECIALIST, { input: { message: /DSP-18/u } });
    turn.calledTool("petstore__getInventory", { output: { body: { available: 7 } } });
    turn.eventsSatisfy("each specialist session belongs to a call of a program", (events) => {
      const opened = events.filter(
        (event) => event.type === "child.opened" && event.data.name === SPECIALIST,
      );
      return (
        opened.length >= 2 &&
        opened.every(
          (event) =>
            event.type === "child.opened" &&
            "callId" in event.data.owner &&
            event.data.owner.callId.includes("/"),
        )
      );
    });
    // The program awaits each reply, so no specialist call becomes a task the model waits on.
    turn.notEvent("task.started", { data: { name: SPECIALIST } });
    turn.messageIncludes(/DSP-17/u);
    turn.messageIncludes(/DSP-18/u);
    turn.messageIncludes(/\b7\b|seven/iu);
  },
});

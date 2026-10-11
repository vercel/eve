import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// `endsTurn` as a function of the execute output: a posted reaction ends the
// turn without a reply, and a reaction that doesn't post lets the model reply.
export default defineEval({
  description: "An endsTurn function decides from the tool's output whether the turn ends.",
  async test(t) {
    const posted = await t.send(
      "Alice shared that the release shipped this morning. Celebrate it with the `react_to_note` tool using the tada emoji.",
    );
    posted.expectOk();
    posted.requireToolCall("react_to_note");
    t.check(
      posted.message,
      satisfies((message) => message === undefined, "a posted reaction sends no reply"),
    );

    const refused = await posted.session.send(
      "Bob would also like to add a rocket reaction to Alice's note with the `react_to_note` tool. Let him know how it went.",
    );
    refused.expectOk();
    refused.requireToolCall("react_to_note");
    t.check(
      refused.message,
      satisfies(
        (message) => typeof message === "string" && message.trim().length > 0,
        "a reaction that doesn't post gets a reply",
      ),
    );
    t.succeeded();
  },
});

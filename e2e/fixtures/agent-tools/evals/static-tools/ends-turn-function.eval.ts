import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// `endsTurn` as a function of the execute output, on a static tool and on a
// dynamic one: a posted reaction ends the turn without a reply, and a reaction
// that doesn't post lets the model reply.
export default (["react_to_note", "dynamic_react_to_note"] as const).map((tool) =>
  defineEval({
    description: `An endsTurn function on ${tool} decides from the tool's output whether the turn ends.`,
    async test(t) {
      const posted = await t.send(
        `Alice shared that the release shipped this morning. Celebrate it with the \`${tool}\` tool using the tada emoji.`,
      );
      posted.expectOk();
      posted.requireToolCall(tool);
      t.check(
        posted.reply,
        satisfies((message) => message === undefined, "a posted reaction sends no reply"),
      );

      const refused = await posted.session.send(
        `Bob would also like to add a rocket reaction to Alice's note with the \`${tool}\` tool. Let him know how it went.`,
      );
      refused.expectOk();
      refused.requireToolCall(tool);
      t.check(
        refused.reply,
        satisfies(
          (message) => typeof message === "string" && message.trim().length > 0,
          "a reaction that doesn't post gets a reply",
        ),
      );
      t.succeeded();
    },
  }),
);

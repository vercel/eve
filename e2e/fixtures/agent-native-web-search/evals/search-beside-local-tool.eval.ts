import { defineEval } from "eve/evals";

// Anthropic defers a server tool called beside a local tool and opens its next response with the
// result; until then, every request must end on the local results.
export default defineEval({
  tags: ["real-model"],
  description: "A web search beside a local tool call leaves the session ready for a follow-up.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is putting together a study plan for Bob about JavaScript arrays.",
        "In one step, call reading_list to see what Bob has already saved, and use web_search to find MDN's English reference for Array.prototype.flatMap.",
        "Then reply with the reference's URL and which of Bob's saved topics it builds on.",
      ].join("\n"),
    );

    turn.expectOk();
    turn.calledTool("reading_list", { status: "completed" });
    turn.calledTool("web_search", { status: "completed" });
    turn.noFailedCalls();

    const followUp = await turn.session.send(
      "Bob wants to review flat before he reads about flatMap. Which notebook page holds his flat notes?",
    );

    followUp.expectOk();
    followUp.messageIncludes(/\b22\b/u);
  },
});

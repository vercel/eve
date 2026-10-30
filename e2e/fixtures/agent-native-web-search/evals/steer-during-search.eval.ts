import { defineEval } from "eve/evals";

/**
 * Alice asks for a web search and Bob's reading list in one step. Anthropic runs the search once
 * the reading list's result is in and opens its next response with the search result. Bob's
 * question arrives while the reading list runs, so it steers the turn inside that window: it
 * waits for the search result, and both requests complete.
 */
export default defineEval({
  description: "A message that steers a turn while a web search result is deferred is answered.",
  tags: ["real-model"],
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      [
        "Alice is putting together a study plan for Bob about JavaScript arrays.",
        "In one step, call reading_list to see what Bob has already saved, and use web_search to find MDN's English reference for Array.prototype.flatMap.",
        "Then reply with the reference's URL and which of Bob's saved topics it builds on.",
      ].join("\n"),
    );
    await live.waitForEvent("call.requested", { data: { capability: { name: "reading_list" } } });

    const question = await live.session.start(
      "Bob also wants to review flat before he reads about flatMap. Which notebook page holds his flat notes?",
      { turnPolicy: "steer" },
    );
    const turn = await live.result();
    const answered = await question.result();

    turn.expectOk();
    answered.expectOk();
    turn.calledTool("reading_list", { status: "completed" });
    turn.calledTool("web_search", { status: "completed" });
    t.messageIncludes(/\b22\b/u).label("Bob's question gets an answer");
    t.noFailedCalls();
  },
});

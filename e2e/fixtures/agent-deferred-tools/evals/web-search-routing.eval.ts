import { defineEval } from "eve/evals";

// `eve__search` finds the agent's own tools, not web pages, so a question about
// the world goes to `web_search` even while the catalog lists many entries.
// Calls through `eve__execute` are reported under their entry's name, so the
// check is that `web_search` is the only tool called.
export default defineEval({
  tags: ["real-model"],
  description: "A web question goes to web_search, not the catalog.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob is writing the team newsletter and wants one line of sports news.",
        "Please look up on the web who won the 2026 NBA Finals and tell him the winning team.",
      ].join(" "),
    );

    turn.expectOk();
    turn.eventsSatisfy("web_search is the only tool called", (events) => {
      const called = events.flatMap((event) =>
        event.type === "actions.requested"
          ? event.data.actions.flatMap((action) =>
              action.kind === "tool-call" ? [action.toolName] : [],
            )
          : [],
      );
      return called.length > 0 && called.every((name) => name === "web_search");
    });
  },
});

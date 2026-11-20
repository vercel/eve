import { defineEval } from "eve/evals";

// `eve__search` finds the agent's own tools, not web pages, so a question about
// the world goes to `web_search` even while the catalog lists many entries.
// Calls through `eve__tool` are reported under their entry's name, so the
// check is that `web_search` is called and nothing but the web tools is.
// Reading a result page with `web_fetch` to confirm the answer is still web research.
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

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
    turn.eventsSatisfy("web_search is called and only web tools are called", (events) => {
      const called = events.flatMap((event) =>
        event.type === "call.requested" && event.data.capability.kind === "tool"
          ? [event.data.capability.name]
          : [],
      );
      return called.includes("web_search") && called.every((name) => WEB_TOOLS.has(name));
    });
  },
});

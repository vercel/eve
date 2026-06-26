import { defineEval } from "eve/evals";

const EXPECTED_WINNERS =
  "2026 New York Knicks; 2025 Oklahoma City Thunder; 2024 Boston Celtics; " +
  "2023 Denver Nuggets; 2022 Golden State Warriors; 2021 Milwaukee Bucks; " +
  "2020 Los Angeles Lakers; 2019 Toronto Raptors; 2018 Golden State Warriors; " +
  "2017 Golden State Warriors.";

export default defineEval({
  description: "Provider tools smoke: ten parallel gateway web searches complete successfully.",
  async test(t) {
    const turn = await t.send(
      "Using 10 parallel web_search calls: lookup the nba finals winner from 2026 back to 2017",
    );

    t.succeeded();
    t.calledTool("web_search", { count: 10 });
    t.noFailedActions();
    t.judge.autoevals.factuality(EXPECTED_WINNERS, { on: turn.message }).atLeast(0.5);
  },
});

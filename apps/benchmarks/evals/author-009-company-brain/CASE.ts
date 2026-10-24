import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

// A company brain from an empty workspace. Each requirement is graded by its own
// check, so a run that gets part of the agent right still scores partial credit.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "atlas",
  // A whole agent from scratch takes strong models about 10 minutes; weaker ones need longer.
  timeoutSeconds: 1800,
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `atlas` project. Atlas is Lumen's company brain: employees ask it questions about the business, and it answers from company data with each employee's own access.",
        "",
        "- People mostly ask it in Slack. We're not using Vercel Connect for Slack on this one; the bot token and signing secret are in `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.",
        "- Our internal portal also calls it over the HTTP API. In production it should only accept tokens from our SSO (OIDC issuer `https://sso.lumen.dev`, audience `atlas`). Nothing else gets in.",
        '- It answers data questions with a `run_sql` tool that takes a `query` string. To run one, POST `{ "sql": <query> }` as JSON to `https://warehouse.lumen.dev/v1/query` with a bearer token from `WAREHOUSE_TOKEN`, and return the result. It has to be read-only: refuse anything that isn\'t a single SELECT (or WITH ... SELECT) before it reaches the warehouse. Anything touching the `pii` schema needs a person to sign off first; other queries can just run.',
        "- It searches and reads our Notion as the employee who asked, so nobody sees pages they couldn't already open. Notion's MCP server is at `https://mcp.notion.com/mcp`, and we've set up the Vercel Connect connector `mcp.notion.com/atlas` for it. Atlas only needs Notion's `search` and `fetch` tools, so hide the rest.",
        "- Finance needs a `revenue_forecast` tool that takes a `quarter` like `2026-Q4` and returns `GET https://warehouse.lumen.dev/v1/forecast?quarter=<quarter>`, using the same warehouse token. Only people in the `finance` group should be able to use it, or even know it exists. Our SSO tokens carry each employee's groups as a `groups` claim.",
        "- For deeper questions, add an `analyze` tool that hands the question to two helpers at once and returns both of their answers: an `analyst` that digs through the warehouse (with the same read-only SQL rules) and a `researcher` that digs through Notion as the employee. Neither helper should be able to touch the other's source. Run both on `anthropic/claude-sonnet-5` to keep costs down. Atlas should only reach them through `analyze`, never on its own.",
        "- It should know our metric definitions, but only pull them in when someone asks about a metric rather than carrying them in every conversation. ARR is the annualized value of active subscriptions, excluding one-time fees. An active customer has at least one paid seat in the last 30 days. Net revenue retention is this month's ARR from customers who were active 12 months ago, divided by their ARR back then.",
        "- Every Monday at 15:00 UTC, it posts a weekly metrics summary to the Slack channel `C0ATLAS01`, including next quarter's revenue forecast.",
        "- Add an eval that asks Atlas how many active customers we have and checks that it answers with `run_sql`. Stub `run_sql` so the eval doesn't need the real warehouse.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});

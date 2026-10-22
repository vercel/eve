import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

// A company brain from an empty workspace. Each requirement is graded by its own
// check, so a run that gets part of the agent right still scores partial credit.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "atlas",
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `atlas` project. Atlas is Lumen's company brain: employees ask it questions about the business, and it answers from company data using each employee's own identity and access.",
        "",
        "- Employees ask it in Slack. There's no Vercel Connect for Slack here, so use the `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` environment variables.",
        "- Our internal portal talks to it over eve's HTTP API. In production, only accept bearer tokens from our SSO: OIDC issuer `https://sso.lumen.dev`, audience `atlas`. Nothing else should get in.",
        '- It queries the data warehouse with a `run_sql` tool that takes a `query` string. It POSTs `{ "sql": <query> }` as JSON to `https://warehouse.lumen.dev/v1/query` with a bearer token from `WAREHOUSE_TOKEN` and returns the result. The tool is read-only: anything other than a single SELECT (or WITH ... SELECT) statement must be refused without calling the warehouse. Queries that touch the `pii` schema need a person to approve them first; everything else runs on its own.',
        "- It searches and reads our Notion as the employee who asked, so people only see pages they already have access to. Use the Notion MCP server at `https://mcp.notion.com/mcp` through the Vercel Connect connector `mcp.notion.com/atlas`. The model should only be able to discover the `search` and `fetch` tools.",
        "- A `revenue_forecast` tool takes a `quarter` such as `2026-Q4` and returns the forecast from `GET https://warehouse.lumen.dev/v1/forecast?quarter=<quarter>` with the same token. Only people in the `finance` group can use it; the signed-in user's groups arrive as a list in the `groups` auth attribute. Everyone else shouldn't even see the tool, with one exception: the weekly summary below includes the forecast, so the scheduled run, which has no signed-in employee, needs the tool too.",
        "- Deep questions go through an `analyze` tool. It sends the question to two specialists at the same time and returns both answers: `analyst`, which can only query the warehouse (with the same read-only `run_sql` rules), and `researcher`, which can only read Notion as the employee. Both specialists run on `anthropic/claude-sonnet-5`. The main model must not be able to call the specialists directly; only `analyze` reaches them.",
        "- It uses Lumen's metric definitions, loaded only when a question involves a business metric. Keep them in a packaged skill with the definitions in a separate reference file: ARR is the annualized value of active subscriptions, excluding one-time fees; an active customer has at least one paid seat in the last 30 days; net revenue retention is this month's ARR from customers who were active 12 months ago, divided by their ARR back then.",
        "- Every Monday at 15:00 UTC it posts a weekly metrics summary to the Slack channel `C0ATLAS01`.",
        "- Add an eve eval that asks Atlas how many active customers we have and checks that it answers by calling `run_sql`, with that tool stubbed so no warehouse is needed.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});

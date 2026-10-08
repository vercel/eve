import { describe, expect, it } from "vitest";

import {
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
} from "#internal/testing/catalog-fixtures.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

// Measures `eve__search` ranking on a catalog shaped like a real agent's, so a
// ranker change shows what it does to the queries models actually send. The
// tools are the `agent-tool-discovery` e2e fixture's catalog, copied because
// `src` can't import from `e2e`.

const str = (description: string) => ({ type: "string", description });

const CATALOG: readonly (readonly [string, string, Readonly<Record<string, string>>?])[] = [
  [
    "sre__status_page_incidents_list",
    "List incidents on the company status page, optionally filtered by status.",
    { status: "open, resolved, or all" },
  ],
  [
    "sre__status_page_incident_get",
    "Get one status page incident by id.",
    { incidentId: "Incident id" },
  ],
  [
    "sre__status_page_incident_create",
    "Open a new status page incident.",
    { title: "Incident title", impact: "none, minor, major, or critical" },
  ],
  [
    "sre__status_page_incident_update",
    "Post an update to a status page incident.",
    { incidentId: "Incident id", message: "Update text" },
  ],
  ["sre__status_page_components_list", "List status page components and their current status."],
  [
    "sre__status_page_component_get",
    "Get one status page component by id.",
    { componentId: "Component id" },
  ],
  [
    "sre__lookup_ownership",
    "Find the team that owns a service, repository, or alert.",
    { subject: "Service, repository, or alert name" },
  ],
  [
    "sre__build_datadog_link",
    "Build a Datadog dashboard link for a service and time range.",
    { service: "Service name", range: "Time range" },
  ],
  [
    "sre__build_cdn_dashboard_link",
    "Build a CDN analytics dashboard link for a project.",
    { project: "Project name" },
  ],
  [
    "sre__evidence_record",
    "Record a piece of evidence on an incident timeline.",
    { incidentId: "Incident id", note: "Evidence" },
  ],
  [
    "sre__evidence_list",
    "List the evidence recorded on an incident timeline.",
    { incidentId: "Incident id" },
  ],
  [
    "sre__evidence_remove",
    "Remove a piece of evidence from an incident timeline.",
    { evidenceId: "Evidence id" },
  ],
  ["sre__oncall_schedule_get", "Get who is on call for a team this week.", { team: "Team name" }],
  ["sre__alert_rules_list", "List alerting rules for a service.", { service: "Service name" }],
  ["sre__deploy_freeze_status", "Check whether a deploy freeze is in effect."],
  [
    "sre__error_budget_get",
    "Get a service's remaining error budget for its SLO.",
    { service: "Service name" },
  ],
  ["d0__run_sql", "Run a read-only SQL query against the data warehouse.", { sql: "SQL query" }],
  [
    "d0__query_metrics",
    "Query a named business metric over a time range.",
    { metric: "Metric name", range: "Time range" },
  ],
  [
    "d0__query_cost",
    "Query cloud infrastructure cost by team or service.",
    { groupBy: "team or service" },
  ],
  [
    "d0__find_customer",
    "Find a customer account by name or domain.",
    { query: "Customer name or domain" },
  ],
  [
    "d0__find_data",
    "Find warehouse tables and columns that hold a kind of data.",
    { topic: "What the data is about" },
  ],
  [
    "d0__profile_site",
    "Profile a customer site's traffic and framework usage.",
    { domain: "Site domain" },
  ],
  ["d0__export_sheet", "Export query results to a spreadsheet.", { queryId: "Query id" }],
  [
    "d0__query_partnerships",
    "Query revenue influenced by partnerships.",
    { partner: "Partner name" },
  ],
  [
    "d0__usage_summary",
    "Summarize a customer's product usage for a month.",
    { customer: "Customer", month: "Month as YYYY-MM" },
  ],
  [
    "d0__revenue_by_plan",
    "Break down monthly recurring revenue by plan.",
    { month: "Month as YYYY-MM" },
  ],
  ["d0__churn_cohorts", "Report customer churn by signup cohort.", { cohort: "Signup quarter" }],
  ["d0__funnel_report", "Report conversion through the signup funnel.", { range: "Time range" }],
  [
    "d0__data_glossary_lookup",
    "Look up the definition of a business metric or term.",
    { term: "Term" },
  ],
  [
    "d0__dashboard_link",
    "Get the link to a saved analytics dashboard.",
    { dashboard: "Dashboard name" },
  ],
  ["d0__query_latency", "Query request latency percentiles for a region.", { region: "Region" }],
  [
    "index__resolve_account",
    "Resolve a company name to its CRM account.",
    { company: "Company name" },
  ],
  [
    "index__list_opportunities",
    "List open sales opportunities for an account.",
    { account: "Account" },
  ],
  [
    "index__get_opportunity_metrics",
    "Get pipeline metrics for an opportunity.",
    { opportunityId: "Opportunity id" },
  ],
  [
    "index__get_call_insights",
    "Summarize insights from recent sales calls with an account.",
    { account: "Account" },
  ],
  [
    "index__get_meeting_transcript",
    "Get the transcript of a recorded meeting.",
    { meetingId: "Meeting id" },
  ],
  [
    "index__list_upcoming_meetings",
    "List upcoming meetings with an account.",
    { account: "Account" },
  ],
  ["index__search_meetings", "Search recorded meetings by topic.", { topic: "Topic" }],
  [
    "index__search_docs",
    "Search the company's internal documentation.",
    { query: "Words to find" },
  ],
  [
    "index__search_customer_stories",
    "Search published customer stories by industry or product.",
    { query: "Words to find" },
  ],
  ["index__search_slack", "Search the company's Slack messages.", { query: "Words to find" }],
  [
    "index__get_sales_guidance",
    "Get the sales playbook guidance for a product.",
    { product: "Product" },
  ],
  ["index__list_implementations", "List customer implementation projects.", { account: "Account" }],
  [
    "index__get_implementation_metrics",
    "Get progress metrics for an implementation project.",
    { implementationId: "Implementation id" },
  ],
  [
    "index__get_activity_metrics",
    "Get a sales rep's activity metrics for a quarter.",
    { rep: "Rep name", quarter: "Quarter" },
  ],
  ["index__list_deliverables", "List deliverables owed to a customer.", { account: "Account" }],
  [
    "index__present_estimate",
    "Prepare a pricing estimate for a customer.",
    { account: "Account", plan: "Plan" },
  ],
  [
    "support__search_cases",
    "Search support cases by keyword or customer.",
    { query: "Words to find" },
  ],
  ["support__usage_cases", "List support cases about usage limits.", { customer: "Customer" }],
  [
    "support__support_billing",
    "Look up a customer's billing details for support.",
    { customer: "Customer" },
  ],
  [
    "support__diagnose_infrastructure",
    "Run infrastructure diagnostics for a customer project.",
    { project: "Project" },
  ],
  [
    "support__link_incident",
    "Link a support case to an incident.",
    { caseId: "Case id", incidentId: "Incident id" },
  ],
  [
    "support__get_email_content",
    "Get the content of a support email thread.",
    { threadId: "Thread id" },
  ],
  ["support__latest_chrome_versions", "List the latest Chrome versions support has verified."],
  ["support__case_get", "Get one support case by id.", { caseId: "Case id" }],
  [
    "support__case_assign",
    "Assign a support case to an agent.",
    { caseId: "Case id", assignee: "Agent" },
  ],
  ["support__case_reply_draft", "Draft a reply to a support case.", { caseId: "Case id" }],
  [
    "support__refund_request_status",
    "Check the status of a customer's refund request.",
    { requestId: "Request id" },
  ],
  [
    "support__sla_breaches_list",
    "List support cases that breached their SLA.",
    { range: "Time range" },
  ],
  ["support__macro_lookup", "Look up a saved support reply macro.", { macro: "Macro name" }],
  [
    "expense_policy_lookup",
    "Look up the company's expense policy for a category.",
    { category: "Expense category" },
  ],
  [
    "holiday_calendar",
    "List an office's company holidays for a month.",
    { office: "Office", month: "Month" },
  ],
  [
    "meeting_room_book",
    "Book a meeting room in an office.",
    { office: "Office", time: "Start time" },
  ],
  [
    "travel_request_status",
    "Check the status of a business travel request.",
    { requestId: "Request id" },
  ],
  ["laptop_order_status", "Check the status of a laptop order from IT.", { orderId: "Order id" }],
  [
    "parking_permit_status",
    "Check the status of an office parking permit.",
    { employee: "Employee" },
  ],
  ["team_directory_lookup", "Look up a person's team, manager, and location.", { person: "Name" }],
  [
    "timezone_overlap",
    "Find working-hour overlap between team members' time zones.",
    { people: "Names, comma separated" },
  ],
  [
    "release_train_schedule",
    "Get the departure time and release captain of the next release train for an app.",
    { app: "web, mobile, or desktop" },
  ],
  ["office_floor_plan", "Get the floor plan of an office.", { office: "Office" }],
];

const linear = fakeConnection({
  name: "linear",
  description: "Linear issue tracker for the engineering team.",
  tools: [
    connectionTool(
      "list_issues",
      { type: "object", properties: { teamId: str("Team id"), state: str("Workflow state") } },
      "List issues, filtered by team, assignee, or state.",
    ),
    connectionTool(
      "get_issue",
      { type: "object", properties: { id: str("Issue id") } },
      "Get one issue by id or identifier, such as ENG-123.",
    ),
    connectionTool(
      "create_issue",
      { type: "object", properties: { title: str("Title"), teamId: str("Team id") } },
      "Create a new issue in a team.",
    ),
    connectionTool(
      "update_issue",
      { type: "object", properties: { id: str("Issue id"), state: str("New state") } },
      "Update an issue's title, state, assignee, or priority.",
    ),
    connectionTool(
      "add_comment",
      { type: "object", properties: { issueId: str("Issue id"), body: str("Markdown body") } },
      "Add a comment to an issue.",
    ),
    connectionTool(
      "list_projects",
      { type: "object", properties: {} },
      "List projects and their progress.",
    ),
    connectionTool("list_teams", { type: "object", properties: {} }, "List the workspace's teams."),
    connectionTool(
      "list_cycles",
      { type: "object", properties: { teamId: str("Team id") } },
      "List a team's cycles (sprints).",
    ),
    connectionTool(
      "search_issues",
      { type: "object", properties: { query: str("Full-text query") } },
      "Search issues by text.",
    ),
    connectionTool("list_users", { type: "object", properties: {} }, "List workspace members."),
  ],
});

const github = fakeConnection({
  name: "github",
  description: "GitHub repositories, pull requests, and Actions.",
  tools: [
    connectionTool(
      "list_pull_requests",
      { type: "object", properties: { repo: str("owner/name"), state: str("open or closed") } },
      "List pull requests in a repository.",
    ),
    connectionTool(
      "get_pull_request",
      { type: "object", properties: { repo: str("owner/name"), number: str("PR number") } },
      "Get a pull request's details.",
    ),
    connectionTool(
      "create_pull_request",
      {
        type: "object",
        properties: { repo: str("owner/name"), head: str("Branch"), title: str("Title") },
      },
      "Open a pull request from a branch.",
    ),
    connectionTool(
      "merge_pull_request",
      { type: "object", properties: { repo: str("owner/name"), number: str("PR number") } },
      "Merge a pull request.",
    ),
    connectionTool(
      "list_issues",
      { type: "object", properties: { repo: str("owner/name") } },
      "List issues in a repository.",
    ),
    connectionTool(
      "create_issue",
      { type: "object", properties: { repo: str("owner/name"), title: str("Title") } },
      "Create an issue in a repository.",
    ),
    connectionTool(
      "search_code",
      { type: "object", properties: { query: str("Code search query") } },
      "Search code across repositories.",
    ),
    connectionTool(
      "get_file_contents",
      { type: "object", properties: { repo: str("owner/name"), path: str("File path") } },
      "Read a file from a repository.",
    ),
    connectionTool(
      "list_commits",
      { type: "object", properties: { repo: str("owner/name") } },
      "List recent commits on a branch.",
    ),
    connectionTool(
      "list_workflow_runs",
      { type: "object", properties: { repo: str("owner/name") } },
      "List GitHub Actions workflow runs and their status.",
    ),
    connectionTool(
      "create_branch",
      { type: "object", properties: { repo: str("owner/name"), name: str("Branch name") } },
      "Create a branch.",
    ),
  ],
});

const tools = CATALOG.map(([name, description, inputs = {}]) =>
  inlineTool(name, {
    deferred: true,
    description,
    schema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(inputs).map(([key, text]) => [key, str(text)])),
    },
  }),
);

/** Queries as models phrase them, with the tools that answer each. */
const QUERIES: readonly (readonly [string, readonly string[]])[] = [
  ["status page incidents", ["sre__status_page_incidents_list"]],
  ["open incidents", ["sre__status_page_incidents_list"]],
  ["create a status page incident", ["sre__status_page_incident_create"]],
  ["who is on call", ["sre__oncall_schedule_get"]],
  ["on-call schedule", ["sre__oncall_schedule_get"]],
  ["which team owns the checkout service", ["sre__lookup_ownership"]],
  ["is there a deploy freeze", ["sre__deploy_freeze_status"]],
  ["error budget", ["sre__error_budget_get"]],
  ["run a SQL query", ["d0__run_sql"]],
  ["revenue by plan", ["d0__revenue_by_plan"]],
  ["churn", ["d0__churn_cohorts"]],
  ["customer lookup by email", ["d0__find_customer", "index__resolve_account"]],
  ["p99 latency for the API", ["d0__query_latency"]],
  ["meeting transcript", ["index__get_meeting_transcript"]],
  ["upcoming customer meetings", ["index__list_upcoming_meetings"]],
  ["sales opportunities pipeline", ["index__list_opportunities"]],
  ["search support cases", ["support__search_cases"]],
  ["draft a reply to a support ticket", ["support__case_reply_draft"]],
  ["refund status", ["support__refund_request_status"]],
  ["SLA breaches", ["support__sla_breaches_list"]],
  ["book a meeting room", ["meeting_room_book"]],
  ["when does the next mobile release train depart", ["release_train_schedule"]],
  ["time zone overlap between two teammates", ["timezone_overlap"]],
  ["expense policy for travel", ["expense_policy_lookup"]],
  ["list open linear issues", ["linear__list_issues"]],
  ["create issue", ["linear__create_issue", "github__create_issue"]],
  ["comment on an issue", ["linear__add_comment"]],
  ["open pull requests", ["github__list_pull_requests"]],
  ["merge PR", ["github__merge_pull_request"]],
  ["CI workflow runs", ["github__list_workflow_runs"]],
  ["read a file from the repo", ["github__get_file_contents"]],
  ["sprint", ["linear__list_cycles"]],
];

describe("eve__search ranking benchmark", () => {
  it("ranks an answering tool first for nearly every query, and in the top five for all", async () => {
    const { catalog, run } = catalogContext({ connections: [linear, github], tools });
    const search = catalog.advertised.get(SEARCH_TOOL_NAME)!;
    const ranks: { query: string; rank: number; top: string[] }[] = [];
    for (const [query, expected] of QUERIES) {
      const output = (await run(() => search.execute!({ limit: 50, query }, {} as never))) as {
        results: { skill?: string; tool?: string }[];
      };
      const names = output.results.map((result) => result.tool ?? result.skill);
      const found = expected.map((name) => names.indexOf(name)).filter((index) => index >= 0);
      ranks.push({
        query,
        rank: found.length === 0 ? Infinity : Math.min(...found) + 1,
        top: names.slice(0, 3) as string[],
      });
    }
    const misses = ranks.filter((entry) => entry.rank > 1);

    expect(ranks.filter((entry) => entry.rank <= 5)).toHaveLength(QUERIES.length);
    // Fails with the queries that missed rank 1, so a regression reads directly.
    expect(misses.length, JSON.stringify(misses, null, 2)).toBeLessThanOrEqual(3);
  });
});

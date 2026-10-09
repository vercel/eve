/**
 * The fixture's deferred tools: a large catalog shaped like a real agent's,
 * with extensions mounted as `sre`, `d0`, and `index`, vendored `support__*`
 * tools, and a few tools without a namespace. Every tool returns fixed data,
 * so a reply that carries a tool's reference proves the model ran it.
 */

export interface CatalogTool {
  readonly description: string;
  readonly name: string;
  /** Optional string inputs, by name and description. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** What the tool returns, beyond its `reference`. */
  readonly result?: Readonly<Record<string, unknown>>;
}

/** The open incidents `sre__status_page_incidents_list` returns. */
export const OPEN_INCIDENTS = [
  { id: "INC-4821", status: "investigating", title: "Elevated API latency in iad1" },
  { id: "INC-4790", status: "monitoring", title: "Delayed webhook deliveries" },
];

/** The next mobile release train `release_train_schedule` returns. */
export const NEXT_RELEASE_TRAIN = {
  captain: "Priya Natarajan",
  departs: "2026-10-14T17:00:00Z",
  train: "mobile-2026.42",
};

const NAMESPACED: readonly CatalogTool[] = [
  // sre: incident response, status page, and observability.
  {
    name: "sre__status_page_incidents_list",
    description: "List incidents on the company status page, optionally filtered by status.",
    inputs: { status: "open, resolved, or all" },
    result: { incidents: OPEN_INCIDENTS },
  },
  {
    name: "sre__status_page_incident_get",
    description: "Get one status page incident by id.",
    inputs: { incidentId: "Incident id" },
  },
  {
    name: "sre__status_page_incident_create",
    description: "Open a new status page incident.",
    inputs: { title: "Incident title", impact: "none, minor, major, or critical" },
  },
  {
    name: "sre__status_page_incident_update",
    description: "Post an update to a status page incident.",
    inputs: { incidentId: "Incident id", message: "Update text" },
  },
  {
    name: "sre__status_page_components_list",
    description: "List status page components and their current status.",
  },
  {
    name: "sre__status_page_component_get",
    description: "Get one status page component by id.",
    inputs: { componentId: "Component id" },
  },
  {
    name: "sre__lookup_ownership",
    description: "Find the team that owns a service, repository, or alert.",
    inputs: { subject: "Service, repository, or alert name" },
  },
  {
    name: "sre__build_datadog_link",
    description: "Build a Datadog dashboard link for a service and time range.",
    inputs: { service: "Service name", range: "Time range" },
  },
  {
    name: "sre__build_cdn_dashboard_link",
    description: "Build a CDN analytics dashboard link for a project.",
    inputs: { project: "Project name" },
  },
  {
    name: "sre__evidence_record",
    description: "Record a piece of evidence on an incident timeline.",
    inputs: { incidentId: "Incident id", note: "Evidence" },
  },
  {
    name: "sre__evidence_list",
    description: "List the evidence recorded on an incident timeline.",
    inputs: { incidentId: "Incident id" },
  },
  {
    name: "sre__evidence_remove",
    description: "Remove a piece of evidence from an incident timeline.",
    inputs: { evidenceId: "Evidence id" },
  },
  {
    name: "sre__oncall_schedule_get",
    description: "Get who is on call for a team this week.",
    inputs: { team: "Team name" },
  },
  {
    name: "sre__alert_rules_list",
    description: "List alerting rules for a service.",
    inputs: { service: "Service name" },
  },
  { name: "sre__deploy_freeze_status", description: "Check whether a deploy freeze is in effect." },
  {
    name: "sre__error_budget_get",
    description: "Get a service's remaining error budget for its SLO.",
    inputs: { service: "Service name" },
  },
  // d0: the data warehouse and business metrics.
  {
    name: "d0__run_sql",
    description: "Run a read-only SQL query against the data warehouse.",
    inputs: { sql: "SQL query" },
  },
  {
    name: "d0__query_metrics",
    description: "Query a named business metric over a time range.",
    inputs: { metric: "Metric name", range: "Time range" },
  },
  {
    name: "d0__query_cost",
    description: "Query cloud infrastructure cost by team or service.",
    inputs: { groupBy: "team or service" },
  },
  {
    name: "d0__find_customer",
    description: "Find a customer account by name or domain.",
    inputs: { query: "Customer name or domain" },
  },
  {
    name: "d0__find_data",
    description: "Find warehouse tables and columns that hold a kind of data.",
    inputs: { topic: "What the data is about" },
  },
  {
    name: "d0__profile_site",
    description: "Profile a customer site's traffic and framework usage.",
    inputs: { domain: "Site domain" },
  },
  {
    name: "d0__export_sheet",
    description: "Export query results to a spreadsheet.",
    inputs: { queryId: "Query id" },
  },
  {
    name: "d0__query_partnerships",
    description: "Query revenue influenced by partnerships.",
    inputs: { partner: "Partner name" },
  },
  {
    name: "d0__usage_summary",
    description: "Summarize a customer's product usage for a month.",
    inputs: { customer: "Customer", month: "Month as YYYY-MM" },
  },
  {
    name: "d0__revenue_by_plan",
    description: "Break down monthly recurring revenue by plan.",
    inputs: { month: "Month as YYYY-MM" },
  },
  {
    name: "d0__churn_cohorts",
    description: "Report customer churn by signup cohort.",
    inputs: { cohort: "Signup quarter" },
  },
  {
    name: "d0__funnel_report",
    description: "Report conversion through the signup funnel.",
    inputs: { range: "Time range" },
  },
  {
    name: "d0__data_glossary_lookup",
    description: "Look up the definition of a business metric or term.",
    inputs: { term: "Term" },
  },
  {
    name: "d0__dashboard_link",
    description: "Get the link to a saved analytics dashboard.",
    inputs: { dashboard: "Dashboard name" },
  },
  {
    name: "d0__query_latency",
    description: "Query request latency percentiles for a region.",
    inputs: { region: "Region" },
  },
  // index: accounts, sales activity, and internal knowledge.
  {
    name: "index__resolve_account",
    description: "Resolve a company name to its CRM account.",
    inputs: { company: "Company name" },
  },
  {
    name: "index__list_opportunities",
    description: "List open sales opportunities for an account.",
    inputs: { account: "Account" },
  },
  {
    name: "index__get_opportunity_metrics",
    description: "Get pipeline metrics for an opportunity.",
    inputs: { opportunityId: "Opportunity id" },
  },
  {
    name: "index__get_call_insights",
    description: "Summarize insights from recent sales calls with an account.",
    inputs: { account: "Account" },
  },
  {
    name: "index__get_meeting_transcript",
    description: "Get the transcript of a recorded meeting.",
    inputs: { meetingId: "Meeting id" },
  },
  {
    name: "index__list_upcoming_meetings",
    description: "List upcoming meetings with an account.",
    inputs: { account: "Account" },
  },
  {
    name: "index__search_meetings",
    description: "Search recorded meetings by topic.",
    inputs: { topic: "Topic" },
  },
  {
    name: "index__search_docs",
    description: "Search the company's internal documentation.",
    inputs: { query: "Words to find" },
  },
  {
    name: "index__search_customer_stories",
    description: "Search published customer stories by industry or product.",
    inputs: { query: "Words to find" },
  },
  {
    name: "index__search_slack",
    description: "Search the company's Slack messages.",
    inputs: { query: "Words to find" },
  },
  {
    name: "index__get_sales_guidance",
    description: "Get the sales playbook guidance for a product.",
    inputs: { product: "Product" },
  },
  {
    name: "index__list_implementations",
    description: "List customer implementation projects.",
    inputs: { account: "Account" },
  },
  {
    name: "index__get_implementation_metrics",
    description: "Get progress metrics for an implementation project.",
    inputs: { implementationId: "Implementation id" },
  },
  {
    name: "index__get_activity_metrics",
    description: "Get a sales rep's activity metrics for a quarter.",
    inputs: { rep: "Rep name", quarter: "Quarter" },
  },
  {
    name: "index__list_deliverables",
    description: "List deliverables owed to a customer.",
    inputs: { account: "Account" },
  },
  {
    name: "index__present_estimate",
    description: "Prepare a pricing estimate for a customer.",
    inputs: { account: "Account", plan: "Plan" },
  },
  // support: vendored support desk tools.
  {
    name: "support__search_cases",
    description: "Search support cases by keyword or customer.",
    inputs: { query: "Words to find" },
  },
  {
    name: "support__usage_cases",
    description: "List support cases about usage limits.",
    inputs: { customer: "Customer" },
  },
  {
    name: "support__support_billing",
    description: "Look up a customer's billing details for support.",
    inputs: { customer: "Customer" },
  },
  {
    name: "support__diagnose_infrastructure",
    description: "Run infrastructure diagnostics for a customer project.",
    inputs: { project: "Project" },
  },
  {
    name: "support__link_incident",
    description: "Link a support case to an incident.",
    inputs: { caseId: "Case id", incidentId: "Incident id" },
  },
  {
    name: "support__get_email_content",
    description: "Get the content of a support email thread.",
    inputs: { threadId: "Thread id" },
  },
  {
    name: "support__latest_chrome_versions",
    description: "List the latest Chrome versions support has verified.",
    inputs: {},
  },
  {
    name: "support__case_get",
    description: "Get one support case by id.",
    inputs: { caseId: "Case id" },
  },
  {
    name: "support__case_assign",
    description: "Assign a support case to an agent.",
    inputs: { caseId: "Case id", assignee: "Agent" },
  },
  {
    name: "support__case_reply_draft",
    description: "Draft a reply to a support case.",
    inputs: { caseId: "Case id" },
  },
  {
    name: "support__refund_request_status",
    description: "Check the status of a customer's refund request.",
    inputs: { requestId: "Request id" },
  },
  {
    name: "support__sla_breaches_list",
    description: "List support cases that breached their SLA.",
    inputs: { range: "Time range" },
  },
  {
    name: "support__macro_lookup",
    description: "Look up a saved support reply macro.",
    inputs: { macro: "Macro name" },
  },
];

const PLAIN: readonly CatalogTool[] = [
  {
    name: "expense_policy_lookup",
    description: "Look up the company's expense policy for a category.",
    inputs: { category: "Expense category" },
  },
  {
    name: "holiday_calendar",
    description: "List an office's company holidays for a month.",
    inputs: { office: "Office", month: "Month" },
  },
  {
    name: "meeting_room_book",
    description: "Book a meeting room in an office.",
    inputs: { office: "Office", time: "Start time" },
  },
  {
    name: "travel_request_status",
    description: "Check the status of a business travel request.",
    inputs: { requestId: "Request id" },
  },
  {
    name: "laptop_order_status",
    description: "Check the status of a laptop order from IT.",
    inputs: { orderId: "Order id" },
  },
  {
    name: "parking_permit_status",
    description: "Check the status of an office parking permit.",
    inputs: { employee: "Employee" },
  },
  {
    name: "team_directory_lookup",
    description: "Look up a person's team, manager, and location.",
    inputs: { person: "Name" },
  },
  {
    name: "timezone_overlap",
    description: "Find working-hour overlap between team members' time zones.",
    inputs: { people: "Names, comma separated" },
  },
  {
    name: "release_train_schedule",
    description: "Get the departure time and release captain of the next release train for an app.",
    inputs: { app: "web, mobile, or desktop" },
    result: NEXT_RELEASE_TRAIN,
  },
  {
    name: "office_floor_plan",
    description: "Get the floor plan of an office.",
    inputs: { office: "Office" },
  },
];

export const CATALOG_TOOLS: readonly CatalogTool[] = [...NAMESPACED, ...PLAIN];

/** A stable reference per tool, so a reply quoting it proves which tool ran. */
export function referenceOf(name: string): string {
  return `REF-${name.replaceAll("_", "-").toUpperCase()}`;
}

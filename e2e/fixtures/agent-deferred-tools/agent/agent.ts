import { e2eAgentConfig } from "@eve-e2e/config";
import { CALL_TOOL, SEARCH_TOOL, SKILL_TOOL, TASK_WAIT_TOOL } from "@eve-e2e/config/catalog-tools";
import {
  callTool,
  latestTaskResult,
  loadSkills,
  outputOf,
  playScript,
} from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { LEDGER_REGIONS } from "./lib/ledger-regions";

/** Every catalog listing says this, whatever kinds it names. */
const LISTING_MARKER = `look for one with ${SEARCH_TOOL}, which searches your own catalog`;

/** Entries that must reach the model only through `eve__search` and `eve__tool`. */
const DEFERRED_SAMPLES = [
  "refund_invoice",
  "deploy_service",
  "research_report",
  "billing_specialist",
  `ledger__${LEDGER_REGIONS[0]}`,
];

/** The first tool `eve__tool` suggested in its error for the call with `id`. */
function suggestedTool(request: MockModelRequest, id: string): string | undefined {
  return /Closest tools: ([A-Za-z0-9_-]+)/u.exec(outputOf(request, id))?.[1];
}

/** Waits for a task's result after its receipt, then reports it. */
function reportTask(
  request: MockModelRequest,
  tool: string,
  label: string,
): MockModelResponse | string {
  const result = latestTaskResult(request, tool);
  return result === undefined
    ? { toolCalls: [{ name: TASK_WAIT_TOOL, input: {} }] }
    : `${label} ${result}`;
}

const SCENARIOS: Record<string, (request: MockModelRequest) => MockModelResponse | string> = {
  /** Reports what the model was told: deferred names in its tool list, and the listing. */
  "DEFERRED-CATALOG": (request) => {
    const listed = DEFERRED_SAMPLES.filter((name) =>
      request.tools.some((tool) => tool.name === name),
    );
    const listing = request.messages.find(
      (message) => message.role === "user" && message.text.includes(LISTING_MARKER),
    );
    return [
      `DEFERRED-IN-TOOLS: ${listed.length === 0 ? "none" : listed.join(", ")}`,
      `CATALOG-TOOLS: ${[SEARCH_TOOL, CALL_TOOL, SKILL_TOOL].filter((name) => request.tools.some((tool) => tool.name === name)).join(", ")}`,
      listing?.text ?? "NO-LISTING",
    ].join("\n");
  },
  "DEFERRED-DEPLOY": (request) =>
    playScript(
      request,
      [callTool("deploy", "deploy_service", { service: "billing-api" })],
      (done) => `DEPLOY-RESULT ${outputOf(done, "deploy")}`,
    ),
  "DEFERRED-RESEARCH": (request) =>
    playScript(request, [callTool("research", "research_report", { topic: "refunds" })], (done) =>
      reportTask(done, "research_report", "RESEARCH-RESULT"),
    ),
  "DEFERRED-SPECIALIST": (request) =>
    playScript(
      request,
      [callTool("specialist", "billing_specialist", { message: "Review Bob's dispute DSP-17." })],
      (done) => reportTask(done, "billing_specialist", "SPECIALIST-RESULT"),
    ),
  "DEFERRED-SKILLS": (request) =>
    loadSkills(request, ["pdf-forms", "release_notes", "tenant-playbook"]),
  /** Calls a misspelled tool, then the first name the error suggests. */
  "DEFERRED-MISSPELLED": (request) =>
    playScript(
      request,
      [
        callTool("misspelled", "refund_invoce", { invoiceId: "INV-2041" }),
        {
          id: "corrected",
          input: (current) => ({
            name: suggestedTool(current, "misspelled"),
            input: { invoiceId: "INV-2041" },
          }),
          name: CALL_TOOL,
        },
      ],
      (done) => `REFUND-RESULT ${outputOf(done, "corrected")}`,
    ),
  /** Finds a dynamic ledger tool with eve__search and calls it, then calls the connection. */
  "DEFERRED-LEDGER": (request) =>
    playScript(
      request,
      [
        { id: "ledger-search", input: () => ({ query: "west ledger" }), name: SEARCH_TOOL },
        {
          id: "ledger",
          input: (current) => ({
            name: /"tool":"(ledger__[a-z_]+)"/u.exec(outputOf(current, "ledger-search"))?.[1],
            input: { month: "2026-09" },
          }),
          name: CALL_TOOL,
        },
        callTool("inventory", "petstore__getInventory"),
      ],
      (done) =>
        `LEDGER-RESULT ${outputOf(done, "ledger")} INVENTORY-RESULT ${outputOf(done, "inventory")}`,
    ),
};

function respond(request: MockModelRequest): MockModelResponse | string {
  const directive = (request.lastUserMessage ?? "").trim().split(/\s+/u)[0] ?? "";
  return SCENARIOS[directive]?.(request) ?? `Mock reply: ${request.lastUserMessage ?? ""}`;
}

const config = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...config,
  // Measure Anthropic cache reuse through its native provider (see cache-after-discovery.eval.ts).
  ...(typeof config.model === "string" && config.model.startsWith("anthropic/")
    ? { modelOptions: { providerOptions: { gateway: { only: ["anthropic"] } } } }
    : {}),
  reasoning: "high",
  limits: { maxInputTokensPerSession: 300_000 },
});

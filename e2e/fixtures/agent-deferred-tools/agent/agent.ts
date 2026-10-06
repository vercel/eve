import { e2eAgentConfig } from "@eve-e2e/config";
import {
  latestTaskResult,
  outputOf,
  playScript,
  type ScriptedCall,
} from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { LEDGER_REGIONS } from "./lib/ledger-regions";

const LISTING_HEADER = "More tools and skills are available than your context shows.";

/** Entries that must reach the model only through `search` and `execute`. */
const DEFERRED_SAMPLES = [
  "refund_invoice",
  "deploy_service",
  "research_report",
  "billing_specialist",
  `ledger_${LEDGER_REGIONS[0]}`,
];

/** An `execute` call with a fixed id, so the script knows once it has a result. */
function execute(
  id: string,
  target: { readonly tool: string; readonly input?: object } | { readonly skill: string },
): ScriptedCall {
  return { id, input: () => target, name: "execute" };
}

/** The first tool `execute` suggested in its error for the call with `id`. */
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
    ? { toolCalls: [{ name: "task_wait", input: {} }] }
    : `${label} ${result}`;
}

const SCENARIOS: Record<string, (request: MockModelRequest) => MockModelResponse | string> = {
  /** Reports what the model was told: deferred names in its tool list, and the listing. */
  "DEFERRED-CATALOG": (request) => {
    const listed = DEFERRED_SAMPLES.filter((name) =>
      request.tools.some((tool) => tool.name === name),
    );
    const listing = request.messages.find(
      (message) => message.role === "user" && message.text.startsWith(LISTING_HEADER),
    );
    return [
      `DEFERRED-IN-TOOLS: ${listed.length === 0 ? "none" : listed.join(", ")}`,
      `CATALOG-TOOLS: ${["search", "execute"].filter((name) => request.tools.some((tool) => tool.name === name)).join(", ")}`,
      listing?.text ?? "NO-LISTING",
    ].join("\n");
  },
  "DEFERRED-DEPLOY": (request) =>
    playScript(
      request,
      [execute("deploy", { tool: "deploy_service", input: { service: "billing-api" } })],
      (done) => `DEPLOY-RESULT ${outputOf(done, "deploy")}`,
    ),
  "DEFERRED-RESEARCH": (request) =>
    playScript(
      request,
      [execute("research", { tool: "research_report", input: { topic: "refunds" } })],
      (done) => reportTask(done, "research_report", "RESEARCH-RESULT"),
    ),
  "DEFERRED-SPECIALIST": (request) =>
    playScript(
      request,
      [
        execute("specialist", {
          tool: "billing_specialist",
          input: { message: "Review Bob's dispute DSP-17." },
        }),
      ],
      (done) => reportTask(done, "billing_specialist", "SPECIALIST-RESULT"),
    ),
  "DEFERRED-SKILLS": (request) =>
    playScript(
      request,
      [
        execute("load-pdf-forms", { skill: "pdf-forms" }),
        execute("load-release-notes", { skill: "release_notes" }),
        execute("load-tenant-playbook", { skill: "tenant-playbook" }),
      ],
      (done) =>
        ["load-pdf-forms", "load-release-notes", "load-tenant-playbook"]
          .map((id) => outputOf(done, id).trim().split("\n").at(-1))
          .join(" "),
    ),
  /** Calls a misspelled tool, then the first name the error suggests. */
  "DEFERRED-MISSPELLED": (request) =>
    playScript(
      request,
      [
        execute("misspelled", { tool: "refund_invoce", input: { invoiceId: "INV-2041" } }),
        {
          id: "corrected",
          input: (current) => ({
            tool: suggestedTool(current, "misspelled"),
            input: { invoiceId: "INV-2041" },
          }),
          name: "execute",
        },
      ],
      (done) => `REFUND-RESULT ${outputOf(done, "corrected")}`,
    ),
  /** Finds a dynamic ledger tool with search and calls it, then calls the connection. */
  "DEFERRED-LEDGER": (request) =>
    playScript(
      request,
      [
        { id: "ledger-search", input: () => ({ query: "west ledger" }), name: "search" },
        {
          id: "ledger",
          input: (current) => ({
            tool: /"tool":"(ledger_[a-z_]+)"/u.exec(outputOf(current, "ledger-search"))?.[1],
            input: { month: "2026-09" },
          }),
          name: "execute",
        },
        execute("inventory", { tool: "petstore__getInventory" }),
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

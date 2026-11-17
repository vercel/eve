import { e2eAgentConfig } from "@eve-e2e/config";
import { CALL_TOOL, SEARCH_TOOL, SKILL_TOOL, TASK_WAIT_TOOL } from "@eve-e2e/config/catalog-tools";
import {
  callTool,
  latestTaskResult,
  loadSkills,
  outputOf,
  playScript,
  programResultOf,
  runProgram,
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

/** Runs `code` as one `eve__execute` program, then reports the one value it returned. */
function reportProgram(
  request: MockModelRequest,
  id: string,
  code: string,
): MockModelResponse | string {
  return playScript(
    request,
    [runProgram(id, code)],
    (done) => `PROGRAM-RESULT ${JSON.stringify(programResultOf(done, id))}`,
  );
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
  /** One program reads a deferred tool, a session-scoped deferred tool, and the connection. */
  "PROGRAM-LEDGER": (request) =>
    reportProgram(
      request,
      "ledger-program",
      `
        const [invoice, ledger, inventory] = await Promise.all([
          tools.lookup_invoice({ invoiceId: "INV-2041" }),
          tools.ledger__us_west({ month: "2026-09" }),
          tools.petstore__getInventory({}),
        ]);
        console.log("checked", invoice.invoiceId);
        return { available: inventory.body.available, balance: ledger.balance, status: invoice.status };
      `,
    ),
  /** One program starts two deployments together; a refused one reads as "not deployed". */
  "PROGRAM-DEPLOY": (request) =>
    reportProgram(
      request,
      "deploy-program",
      `
        const outcomes = await Promise.allSettled(
          ["billing-api", "ledger-api"].map((service) => tools.deploy_service({ service })),
        );
        return outcomes.map((outcome) =>
          outcome.status === "fulfilled" ? outcome.value : "not deployed",
        );
      `,
    ),
  /** One program awaits a background workflow tool, then uses its result beside another call. */
  "PROGRAM-RESEARCH": (request) =>
    reportProgram(
      request,
      "research-program",
      `
        const findings = await tools.research_report({ topic: "refunds" });
        const invoice = await tools.lookup_invoice({ invoiceId: "INV-2041" });
        return { findings, status: invoice.status };
      `,
    ),
  /** One program asks the specialist about two disputes at once. */
  "PROGRAM-SPECIALISTS": (request) =>
    reportProgram(
      request,
      "specialist-program",
      `
        return await Promise.all([
          tools.billing_specialist({ message: "Review Bob's dispute DSP-17." }),
          tools.billing_specialist({ message: "Review Alice's dispute DSP-18." }),
        ]);
      `,
    ),
};

function respond(request: MockModelRequest): MockModelResponse | string {
  const directive = (request.lastUserMessage ?? "").trim().split(/\s+/u)[0] ?? "";
  return SCENARIOS[directive]?.(request) ?? `Mock reply: ${request.lastUserMessage ?? ""}`;
}

const config = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...config,
  // Adds eve__execute beside the catalog tools: programs call every entry as `tools.<name>(input)`.
  codeMode: true,
  // Measure Anthropic cache reuse through its native provider (see cache-after-discovery.eval.ts).
  ...(typeof config.model === "string" && config.model.startsWith("anthropic/")
    ? { modelOptions: { providerOptions: { gateway: { only: ["anthropic"] } } } }
    : {}),
  reasoning: "high",
  limits: { sessionUsage: ({ window }) => window.inputTokens - window.cacheReadTokens >= 300_000 },
});

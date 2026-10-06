import { defineEval } from "eve/evals";

import { LEDGER_REGIONS } from "../agent/lib/ledger-regions";
import { requireMockModel } from "./mock-only";

const DEFERRED_TOOLS = [
  "apply_discount",
  "close_account",
  "deploy_service",
  "export_ledger",
  ...LEDGER_REGIONS.map((region) => `ledger_${region}`),
  "list_disputes",
  "lookup_invoice",
  "refund_invoice",
  "research_report",
  "resend_receipt",
  "schedule_payout",
  "summarize_usage",
  "tag_customer",
  "update_billing_email",
  "void_invoice",
].sort();

export default defineEval({
  description:
    "Deferred entries stay out of the tool list, which keeps search and execute, and one sorted listing names them.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-CATALOG");

    turn.expectOk();
    turn.usedNoTools();
    t.messageIncludes("DEFERRED-IN-TOOLS: none");
    t.messageIncludes("CATALOG-TOOLS: search, execute");
    t.messageIncludes(`Tools: ${DEFERRED_TOOLS.join(", ")}`);
    t.messageIncludes("Agents: billing_specialist");
    t.messageIncludes("Skills: pdf-forms, release_notes, tenant-playbook");
    t.messageIncludes("Connections:\n- petstore: Pet store inventory API.");
  },
});

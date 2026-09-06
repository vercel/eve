import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const SIDE_EFFECT_CLASS = [
  "financial_transfer",
  "pii_read",
  "external_write",
  "audit_sink",
  "none",
] as const;

export default defineTool({
  description: "Record a compliance audit event. Always executes without requiring approval.",
  inputSchema: z.object({
    event_type: z.enum([
      "transfer_initiated",
      "pii_accessed",
      "policy_decision",
      "approval_granted",
      "approval_denied",
    ]),
    subject: z.string(),
    // Adapter contract fields. Pass these to make the receipt fully observable:
    // a consumer can verify that the logged decision matches what Eve recorded.
    side_effect_class: z.enum(SIDE_EFFECT_CLASS).optional(),
    input_digest: z.string().optional(),
    session_principal: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  approval: never(),
  async execute(input) {
    return {
      logged: true,
      // Unique receipt id — correlates this entry across SIEM pipelines.
      receipt_id: randomUUID(),
      event_type: input.event_type,
      subject: input.subject,
      side_effect_class: input.side_effect_class ?? "none",
      ...(input.input_digest !== undefined ? { input_digest: input.input_digest } : {}),
      ...(input.session_principal !== undefined
        ? { session_principal: input.session_principal }
        : {}),
    };
  },
});

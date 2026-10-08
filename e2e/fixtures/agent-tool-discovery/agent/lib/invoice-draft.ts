/**
 * A deferred tool whose input schema is deeper than the advertised signature
 * renders: `routing.approvals.finance.policy.thresholds.override.reasonCode`
 * sits past the signature's depth limit, so the model sees `unknown` there and
 * learns the allowed values only from eve__execute's validation issues.
 */

export const INVOICE_DRAFT_TOOL = "billing__invoice_draft_create";

/** The draft id the tool returns, which a reply carries only if the call ran. */
export const INVOICE_DRAFT_ID = "DRAFT-77310";

export const REASON_CODES = ["CONTRACT_EXCEPTION", "PILOT_DISCOUNT", "GOODWILL_CREDIT"] as const;

export const INVOICE_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customerId", "currency", "lines", "routing"],
  properties: {
    customerId: { type: "string", pattern: "^cus_[0-9]{6}$", description: "Customer id" },
    currency: { type: "string", enum: ["usd", "eur", "gbp"] },
    lines: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sku", "quantity", "unitAmountCents"],
        properties: {
          sku: { type: "string", pattern: "^SKU-[A-Z0-9]{4}$" },
          quantity: { type: "integer", minimum: 1 },
          unitAmountCents: { type: "integer", minimum: 0 },
        },
      },
    },
    routing: {
      type: "object",
      additionalProperties: false,
      required: ["approvals"],
      properties: {
        approvals: {
          type: "object",
          additionalProperties: false,
          required: ["finance"],
          properties: {
            finance: {
              type: "object",
              additionalProperties: false,
              required: ["policy"],
              properties: {
                policy: {
                  type: "object",
                  additionalProperties: false,
                  required: ["thresholds"],
                  properties: {
                    thresholds: {
                      type: "object",
                      additionalProperties: false,
                      required: ["override"],
                      properties: {
                        override: {
                          type: "object",
                          additionalProperties: false,
                          required: ["reasonCode"],
                          properties: {
                            reasonCode: {
                              type: "string",
                              enum: [...REASON_CODES],
                              description: "Why the draft skips the standard approval threshold",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

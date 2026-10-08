/**
 * A deferred tool whose input schema is deeper than the advertised signature
 * renders: `routing.approvals.finance.policy.thresholds.override.reasonCode`
 * sits past the signature's depth limit, so the model sees `unknown` there and
 * learns the allowed values only from eve__execute's validation issues.
 */

export const INVOICE_DRAFT_TOOL = "billing__invoice_draft_create";

/** The draft id the tool returns, which a reply carries only if the call ran. */
export const INVOICE_DRAFT_ID = "DRAFT-77310";

/**
 * Lowercase dotted codes rather than SCREAMING_CASE, so a model cannot guess the
 * value from the request's wording and has to read it from validation issues.
 */
export const REASON_CODES = ["exc.contract", "disc.pilot", "cred.goodwill"] as const;

/** The code the eval's request ("the pilot discount we agreed on") maps to. */
export const PILOT_DISCOUNT = "disc.pilot";

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

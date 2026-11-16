import {
  Link,
  LinkApiError,
  type LinkOptions,
  type SpendRequest,
} from "@stripe/link-sdk";
import { createLinkTools } from "@stripe/link-sdk/tools";
import { defineTool } from "eve/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { linkAuth } from "@agent/lib/link-auth";
import { requireWorkerScope } from "../lib/access";
import { requireOwnedBrowserSession } from "../lib/owned-browser";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  fillKernelPaymentFields,
  PaymentFillError,
} from "../lib/autofill/native";

const paymentFieldSchema = z.strictObject({
  field: z.enum([
    "name",
    "number",
    "exp_month",
    "exp_year",
    "expiration",
    "cvc",
    "postal_code",
  ]),
  selector: z.string().trim().min(1).max(1000),
  frameUrl: z.url().max(4000).optional(),
  format: z.enum(["MM/YY", "MM/YYYY"]).optional(),
});

const inputSchema = z
  .strictObject({
    browserSessionId: z.string().trim().min(1).max(500),
    spendRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[a-z]{3}$/u),
    pageUrl: z.url().max(4000).optional(),
    fields: z.array(paymentFieldSchema).min(3).max(6).optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.fields) return;
    if (!input.pageUrl)
      ctx.addIssue({
        code: "custom",
        path: ["pageUrl"],
        message: "Field bindings require the exact current checkout URL.",
      });
    const roles = new Set(input.fields.map(({ field }) => field));
    const hasExpiry = roles.has("expiration")
      ? !roles.has("exp_month") && !roles.has("exp_year")
      : roles.has("exp_month") && roles.has("exp_year");
    if (
      roles.size !== input.fields.length ||
      !roles.has("number") ||
      !roles.has("cvc") ||
      !hasExpiry
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message:
          "Bind each card field once, including number, CVC, and either combined expiration or both month and year.",
      });
    }
    for (const [index, binding] of input.fields.entries()) {
      if ((binding.field === "expiration") !== (binding.format !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "format"],
          message: "Only combined expiration requires a format.",
        });
      }
    }
  });

export default defineTool({
  description:
    "Fill a standard card checkout with an approved Link spend request. Supply only its ID, an owned browser session, and the total amount in minor units and lowercase currency just observed at checkout. The tool retrieves credentials and billing ZIP from the signed-in user's wallet, verifies approval and merchant origin, and fills them server-side. Never provide or read card details, or substitute a personal/shipping ZIP for the card's billing ZIP. For hosted payment fields, supply the exact current pageUrl and CSS field bindings observed without reading values; include postal_code for a billing ZIP input and optional frameUrl to disambiguate inputs across frames. Combined expiration requires MM/YY or MM/YYYY. Supported processor frames include Braintree, Shopify, PayPal card fields, and Stripe. Without bindings, focus a same-origin card field for native autofill. This does not submit a purchase; verify the merchant and total again before submitting. Shared Payment Tokens, Link Pay Tokens, and recurring requests are unsupported here.",
  inputSchema,
  outputSchema: z.object({
    success: z.literal(true),
    spendRequestId: z.string(),
    origin: z.string(),
    amount: z.number(),
    currency: z.string(),
    filledClaims: z.number().int().nonnegative(),
  }),
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.browserSessionId);
    // Eve resolves this provider against the current caller, never model input.
    const { token: accessToken } = await context.getToken(linkAuth);
    const client = new Link({
      accessToken,
      fetch(resource, init) {
        return fetch(resource, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([
            context.abortSignal,
            AbortSignal.timeout(15_000),
          ]),
        });
      },
    } satisfies LinkOptions);

    let request: SpendRequest | null;
    try {
      request = await createLinkTools(client).retrieve_spend_request.execute(
        { id: input.spendRequestId, include: ["card"] },
        undefined
      );
    } catch (error) {
      if (error instanceof LinkApiError && error.status === 401) {
        context.requireAuth(linkAuth);
      }
      // oxlint-disable-next-line eslint/preserve-caught-error -- Link errors can contain credentials; never journal their cause.
      throw new Error(
        "Could not retrieve this Link request from your wallet. Check its status before retrying."
      );
    }
    if (
      !request ||
      request.id !== input.spendRequestId ||
      request.status !== "approved"
    ) {
      throw new Error(
        "This Link request is not currently approved. Return its ID to the coordinator; do not fill or submit payment."
      );
    }
    if (
      request.credential_type !== "card" ||
      request.shared_payment_token ||
      request.link_pay_token ||
      request.recurring
    ) {
      throw new Error(
        "This tool supports only one-time Link card requests for standard card forms."
      );
    }
    if (
      request.amount !== input.amount ||
      request.currency !== input.currency
    ) {
      throw new Error(
        "The checkout total or currency differs from the approved Link request. Obtain approval for the current purchase before proceeding."
      );
    }
    const merchant = URL.parse(request.merchant_url ?? "");
    if (
      merchant?.protocol !== "https:" ||
      merchant.username ||
      merchant.password
    ) {
      throw new Error(
        "The Link request has no valid HTTPS merchant URL. Ask the coordinator to correct the request."
      );
    }
    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal: context.abortSignal,
      pageUrl: input.pageUrl,
    });
    if (origin !== merchant.origin) {
      throw new Error(
        "The active checkout does not match the approved Link merchant origin. Do not fill this page."
      );
    }

    // Validate the fields required by Chromium without returning validation input.
    const parsed = z
      .object({
        number: z.string().regex(/^\d{12,19}$/u),
        cvc: z.string().regex(/^\d{3,4}$/u),
        exp_month: z.number().int().min(1).max(12),
        exp_year: z.number().int().min(2000).max(2100),
        billing_address: z.object({
          name: z.string().trim().min(1),
          postal_code: z
            .string()
            .trim()
            .transform((value) => value || undefined)
            .optional(),
        }),
        valid_until: z.string().optional(),
      })
      .safeParse(request.card);
    if (!parsed.success) {
      throw new Error(
        "Link has not supplied complete card details. Return the request ID to the coordinator; never ask for card details in chat."
      );
    }
    const card = parsed.data;
    if (
      input.fields?.some(({ field }) => field === "postal_code") &&
      !card.billing_address.postal_code
    ) {
      throw new Error(
        "Link has not supplied this card's billing ZIP. Ask the coordinator for the card's billing ZIP; do not substitute personal or shipping information."
      );
    }
    const now = Date.now();
    const validUntil =
      card.valid_until === undefined
        ? undefined
        : /^\d+(?:\.\d+)?$/u.test(card.valid_until)
          ? Number(card.valid_until) * 1000
          : Date.parse(card.valid_until);
    if (
      Date.UTC(card.exp_year, card.exp_month) <= now ||
      (validUntil !== undefined &&
        (!Number.isFinite(validUntil) || validUntil <= now)) ||
      (request.expires_at !== undefined && request.expires_at * 1000 <= now)
    ) {
      throw new Error(
        "The Link payment credential or request has expired. Do not fill or submit payment."
      );
    }
    const claims = (
      [
        ["cc-name", card.billing_address.name],
        ["cc-number", card.number],
        ["cc-exp-month", String(card.exp_month).padStart(2, "0")],
        ["cc-exp-year", String(card.exp_year)],
        ["cc-csc", card.cvc],
        ...(card.billing_address.postal_code
          ? [["postal-code", card.billing_address.postal_code] as const]
          : []),
      ] as const
    ).map(([token, value]) => ({ id: randomUUID(), token, value }));

    try {
      // The existing injector rechecks the origin and masks filled card fields.
      const result = input.fields
        ? await fillKernelPaymentFields({
            browserSessionId: input.browserSessionId,
            pageUrl: z.url().parse(input.pageUrl),
            expectedOrigin: origin,
            fields: input.fields.map((binding) => {
              if (binding.field === "postal_code") {
                const value = card.billing_address.postal_code;
                if (!value)
                  throw new Error(
                    "Link has not supplied this card's billing ZIP."
                  );
                return {
                  selector: binding.selector,
                  frameUrl: binding.frameUrl,
                  value,
                  token: "postal-code",
                };
              }
              const values = {
                name: card.billing_address.name,
                number: card.number,
                exp_month: String(card.exp_month).padStart(2, "0"),
                exp_year: String(card.exp_year),
                expiration: `${String(card.exp_month).padStart(2, "0")}/${binding.format === "MM/YY" ? String(card.exp_year).slice(-2) : String(card.exp_year)}`,
                cvc: card.cvc,
              };
              return {
                selector: binding.selector,
                frameUrl: binding.frameUrl,
                value: values[binding.field],
                token:
                  binding.field === "exp_month" ? "cc-exp-month" : undefined,
              };
            }),
            signal: context.abortSignal,
          })
        : await fillWithKernelNativeAutofill({
            browserSessionId: input.browserSessionId,
            claims,
            expectedOrigin: origin,
            kind: "payment",
            signal: context.abortSignal,
            pageUrl: input.pageUrl,
          });
      return {
        success: true as const,
        spendRequestId: input.spendRequestId,
        origin: result.origin,
        amount: input.amount,
        currency: input.currency,
        filledClaims: result.filledClaims,
      };
    } catch (error) {
      // Other injector errors may echo browser state, so only a
      // PaymentFillError's checkout-state message reaches the worker.
      // oxlint-disable-next-line eslint/preserve-caught-error -- The cause is withheld for the same reason.
      throw new Error(
        `${error instanceof PaymentFillError ? `${error.message} ` : ""}Link card filling could not be confirmed. Check field bindings and the current checkout without reading payment values; do not submit or retry blindly.`
      );
    }
  },
});

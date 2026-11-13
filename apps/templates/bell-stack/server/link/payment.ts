import { z } from "zod";

const selector = z.string().min(1).max(500).refine(value => !value.includes(">>") && !/^(xpath|text|role)=|^\//i.test(value), "Use an exact CSS selector.");
const target = z.strictObject({ selector, frame: selector.optional() });
export const checkoutInput = z.strictObject({
  id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  amount: z.number().int().positive(), currency: z.string().regex(/^[a-z]{3}$/),
  credential: z.literal("card"),
  fields: z.array(target.extend({ field: z.enum(["number", "cvc", "exp_month", "exp_year", "expiry", "name", "line1", "line2", "city", "state", "postal_code", "country"]) })).min(1).max(16),
  submit: target, confirmation: target.optional(),
});
export type CheckoutInput = z.infer<typeof checkoutInput>;
const request = z.object({
  id: z.string(), status: z.string(), merchant_url: z.string().url(), amount: z.number().int().positive(),
  currency: z.string(), expires_at: z.number().optional(), credential_type: z.string().optional(),
});
const address = z.object({ name: z.string(), line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), postal_code: z.string().optional(), country: z.string() });
const credentials = z.object({
  card: z.object({ number: z.string().min(1), cvc: z.string().optional(), exp_month: z.number().int().min(1).max(12), exp_year: z.number().int().min(2000), billing_address: address.optional(), valid_until: z.string().optional() }).optional(),
});

export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Checkout requires an approved HTTPS origin.");
  return url.origin;
}

export function paymentOrigins(value: unknown, input: CheckoutInput): string[] {
  const parsed = request.safeParse(value);
  if (!parsed.success) throw new Error("Link did not return complete purchase metadata.");
  const data = parsed.data;
  if (data.id !== input.id || data.status !== "approved" || data.amount !== input.amount || data.currency.toLowerCase() !== input.currency
    || (data.credential_type && data.credential_type !== input.credential)
    || (data.expires_at !== undefined && data.expires_at * 1000 <= Date.now()))
    throw new Error("The current Link approval does not match this checkout. Verify the existing request before proceeding.");
  const merchant = httpsOrigin(data.merchant_url);
  const configured = z.record(z.string(), z.array(z.string())).parse(JSON.parse(process.env.LINK_CHECKOUT_ORIGINS ?? "{}"));
  return [...new Set([merchant, ...(configured[merchant] ?? []).map(httpsOrigin)])];
}

export function paymentValues(value: unknown, input: CheckoutInput): string[] {
  const parsed = credentials.safeParse(value);
  if (!parsed.success) throw new Error("Link returned an unsupported payment credential.");
  const card = parsed.data.card;
  if (!card) throw new Error("The approved payment credential is unavailable.");
  if (card.valid_until && (!Number.isFinite(Date.parse(card.valid_until)) || Date.parse(card.valid_until) <= Date.now()))
    throw new Error("The approved payment credential has expired.");
  const values: Record<string, string | undefined> = {
    ...card.billing_address, number: card.number, cvc: card.cvc,
    exp_month: String(card.exp_month).padStart(2, "0"), exp_year: String(card.exp_year),
    expiry: `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`,
  };
  return input.fields.map(({ field }) => {
    const resolved = values[field];
    if (!resolved || resolved.length > 4096) throw new Error("A required payment field is unavailable.");
    return resolved;
  });
}

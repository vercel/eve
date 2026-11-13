import { afterEach, describe, expect, it, vi } from "vitest";
import { checkoutInput, paymentOrigins, paymentValues, type CheckoutInput } from "../server/link/payment";

const input: CheckoutInput = { id: "spend_fixture", amount: 100, currency: "usd", credential: "card", fields: [{ field: "number", selector: "#card" }, { field: "expiry", selector: "#expiry" }], submit: { selector: "#pay" } };
const approved = { id: input.id, status: "approved", amount: 100, currency: "usd", merchant_url: "https://merchant.example/item", credential_type: "card" };
afterEach(() => vi.unstubAllEnvs());
describe("approved Link payment contract", () => {
  it.each([{ status: "pending_approval" }, { status: "canceled" }, { amount: 101 }, { currency: "eur" }, { id: "other" }, { credential_type: "link_pay_token" }, { expires_at: 1 }])("refuses mismatched or expired approval: %j", change => {
    expect(() => paymentOrigins({ ...approved, ...change }, input)).toThrow("approval");
  });
  it("derives frame origins only from the approved merchant and server configuration", () => {
    vi.stubEnv("LINK_CHECKOUT_ORIGINS", '{"https://merchant.example":["https://payments.example"],"https://other.example":["https://attacker.example"]}');
    expect(paymentOrigins(approved, input)).toEqual(["https://merchant.example", "https://payments.example"]);
    expect(() => paymentOrigins({ ...approved, merchant_url: "http://merchant.example" }, input)).toThrow();
    expect(() => paymentOrigins({ ...approved, merchant_url: "https://user:pass@merchant.example" }, input)).toThrow();
  });
  it("maps requested card fields and rejects expired credentials", () => {
    expect(paymentValues({ card: { number: "synthetic-number", exp_month: 3, exp_year: 2031 } }, input)).toEqual(["synthetic-number", "03/31"]);
    expect(() => paymentValues({ card: { number: "synthetic-number", exp_month: 3, exp_year: 2031, valid_until: "2000-01-01" } }, input)).toThrow("expired");
  });
  it.each(["shared_payment_token", "link_pay_token"])("rejects unsupported token protocol %s", credential => {
    expect(checkoutInput.safeParse({ ...input, credential }).success).toBe(false);
  });
  it("rejects raw credentials, cross-frame selector syntax, and missing requested values", () => {
    expect(checkoutInput.safeParse({ ...input, number: "secret" }).success).toBe(false);
    expect(checkoutInput.safeParse({ ...input, submit: { selector: "iframe >> input" } }).success).toBe(false);
    expect(() => paymentValues({ card: { number: "synthetic-number", exp_month: 3, exp_year: 2031 } }, { ...input, fields: [{ field: "cvc", selector: "#cvc" }] })).toThrow("unavailable");
  });
});

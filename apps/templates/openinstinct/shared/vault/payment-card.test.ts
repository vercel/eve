import { describe, expect, it } from "vitest";
import {
  paymentCardBrand,
  paymentCardSecretStringSchema,
  paymentCardType,
  serializePaymentCard,
} from "@shared/vault/schema";

describe("payment card vault values", () => {
  it("serializes a complete structured card secret", () => {
    const secret = serializePaymentCard({
      billingPostalCode: "11217",
      cardholderName: "Ada Lovelace",
      expirationMonth: 12,
      expirationYear: 2030,
      kind: "payment-card",
      number: "4242424242424242",
      securityCode: "123",
      version: 1,
    });

    expect(paymentCardSecretStringSchema.safeParse(secret).success).toBe(true);
    expect(JSON.parse(secret)).toEqual(
      expect.objectContaining({
        billingPostalCode: "11217",
        cardholderName: "Ada Lovelace",
        number: "4242424242424242",
      })
    );
  });

  it("identifies card networks without storing extra metadata", () => {
    expect(paymentCardBrand("4242 4242 4242 4242")).toBe("Visa");
    expect(paymentCardBrand("378282246310005")).toBe("American Express");
    expect(paymentCardBrand("30569309025904")).toBe("Diners Club");
    expect(paymentCardBrand("3530111333300000")).toBe("JCB");
    expect(paymentCardBrand("6212345678901234")).toBe("UnionPay");
    expect(paymentCardBrand("6759649826438453")).toBe("Maestro");
    expect(paymentCardBrand("401178")).toBe("Elo");
    expect(paymentCardBrand("123456789012")).toBe("Card");
  });

  it("returns only unambiguous type-as-you-go matches", () => {
    expect(paymentCardType("4")).toBeUndefined();
    expect(paymentCardType("4242")).toMatchObject({ niceType: "Visa" });
    expect(paymentCardType("3782")).toMatchObject({
      code: { name: "CID", size: 4 },
      gaps: [4, 10],
      niceType: "American Express",
    });
  });
});

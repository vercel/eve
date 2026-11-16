import { describe, expect, it } from "vitest";
import {
  addressVaultPayloadStringSchema,
  contactVaultPayloadStringSchema,
  loginAccountHint,
  loginIdentifierSchema,
  loginOriginSchema,
  loginVaultPayloadStringSchema,
  parseAddressVaultPayload,
  parseContactVaultPayload,
  parseLoginVaultPayload,
  serializeAddressVaultPayload,
  serializeContactVaultPayload,
  serializeLoginVaultPayload,
} from "@shared/vault/schema";

describe("versioned vault payloads", () => {
  it("stores password and passwordless login methods", () => {
    const passwordLogin = serializeLoginVaultPayload({
      authentication: { password: "correct horse", type: "password" },
      identifier: { type: "email", value: "ada@example.com" },
      kind: "login",
      origin: "https://www.ubereats.com",
      version: 2,
    });
    const otpLogin = serializeLoginVaultPayload({
      authentication: { type: "sms_otp" },
      identifier: { type: "phone", value: "+15555550100" },
      kind: "login",
      origin: "https://auth.uber.com",
      version: 2,
    });

    expect(loginVaultPayloadStringSchema.safeParse(passwordLogin).success).toBe(
      true
    );
    expect(parseLoginVaultPayload(otpLogin)).toEqual(
      expect.objectContaining({ authentication: { type: "sms_otp" } })
    );
  });

  it("rejects an OTP method that does not match its identifier", () => {
    expect(() =>
      serializeLoginVaultPayload({
        authentication: { type: "sms_otp" },
        identifier: { type: "email", value: "ada@example.com" },
        kind: "login",
        origin: "https://auth.uber.com",
        version: 2,
      })
    ).toThrow("SMS OTP");
  });

  it("uses the shared identifier schema to reject invalid login emails", () => {
    expect(
      loginIdentifierSchema.safeParse({
        type: "email",
        value: "not-an-email",
      }).success
    ).toBe(false);
  });

  it("rejects an invalid login origin without throwing", () => {
    expect(() => loginOriginSchema.safeParse("")).not.toThrow();
    expect(loginOriginSchema.safeParse("").success).toBe(false);
  });

  it("reads legacy logins but does not accept them for new writes", () => {
    const legacy = JSON.stringify({
      authentication: { password: "correct horse", type: "password" },
      identifier: { type: "email", value: "ada@example.com" },
      kind: "login",
      version: 1,
    });

    expect(parseLoginVaultPayload(legacy)?.version).toBe(1);
    expect(loginVaultPayloadStringSchema.safeParse(legacy).success).toBe(false);
  });

  it("stores addresses and contacts as structured encrypted payloads", () => {
    const address = serializeAddressVaultPayload({
      city: "London",
      countryCode: "gb",
      kind: "address",
      line1: "12 St James's Square",
      postalCode: "SW1Y 4LB",
      recipientName: "Ada Lovelace",
      region: "London",
      version: 1,
    });
    const contact = serializeContactVaultPayload({
      dateOfBirth: "1815-12-10",
      email: "ada@example.com",
      fullName: "Ada Lovelace",
      kind: "contact",
      phone: "+442079460000",
      version: 1,
    });

    expect(addressVaultPayloadStringSchema.safeParse(address).success).toBe(
      true
    );
    expect(contactVaultPayloadStringSchema.safeParse(contact).success).toBe(
      true
    );
    expect(parseAddressVaultPayload(address)?.countryCode).toBe("GB");
    expect(parseContactVaultPayload(contact)).toEqual(
      expect.objectContaining({
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
      })
    );
  });

  it("creates only a masked login metadata hint", () => {
    expect(loginAccountHint({ type: "email", value: "ada@example.com" })).toBe(
      "a•••@example.com"
    );
    expect(loginAccountHint({ type: "phone", value: "+15555550100" })).toBe(
      "Phone · •••• 0100"
    );
    expect(
      loginAccountHint(
        { type: "email", value: "ada@example.com" },
        "https://www.ubereats.com"
      )
    ).toBe("www.ubereats.com · a•••@example.com");
  });
});

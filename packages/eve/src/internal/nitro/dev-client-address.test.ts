import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_CLIENT_ADDRESS_HEADER,
  DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER,
  readTrustedDevelopmentClientAddress,
  stampDevelopmentClientAddress,
  timingSafeEqualStrings,
} from "#internal/nitro/dev-client-address.js";

const SECRET = "test-transport-secret";

describe("development client address metadata", () => {
  it("round-trips a stamped address through signature verification", () => {
    const headers = new Headers();
    stampDevelopmentClientAddress(headers, "192.168.1.5", SECRET);
    expect(readTrustedDevelopmentClientAddress(headers, SECRET)).toBe("192.168.1.5");
  });

  it("strips forged public copies before stamping", () => {
    const headers = new Headers({
      [DEVELOPMENT_CLIENT_ADDRESS_HEADER]: "203.0.113.7",
      [DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER]: "forged",
    });
    stampDevelopmentClientAddress(headers, "10.0.0.9", SECRET);
    expect(headers.get(DEVELOPMENT_CLIENT_ADDRESS_HEADER)).toBe("10.0.0.9");
    expect(readTrustedDevelopmentClientAddress(headers, SECRET)).toBe("10.0.0.9");
  });

  it("drops the metadata entirely when no secret or address is available", () => {
    const headers = new Headers({
      [DEVELOPMENT_CLIENT_ADDRESS_HEADER]: "203.0.113.7",
      [DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER]: "forged",
    });
    stampDevelopmentClientAddress(headers, undefined, SECRET);
    expect(headers.get(DEVELOPMENT_CLIENT_ADDRESS_HEADER)).toBeNull();
    expect(headers.get(DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER)).toBeNull();
  });

  it("rejects a tampered address or signature", () => {
    const headers = new Headers();
    stampDevelopmentClientAddress(headers, "192.168.1.5", SECRET);
    headers.set(DEVELOPMENT_CLIENT_ADDRESS_HEADER, "203.0.113.7");
    expect(readTrustedDevelopmentClientAddress(headers, SECRET)).toBeUndefined();

    const forged = new Headers({
      [DEVELOPMENT_CLIENT_ADDRESS_HEADER]: "203.0.113.7",
      [DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER]: "not-a-signature",
    });
    expect(readTrustedDevelopmentClientAddress(forged, SECRET)).toBeUndefined();
  });

  it("rejects verification without a secret", () => {
    const headers = new Headers();
    stampDevelopmentClientAddress(headers, "192.168.1.5", SECRET);
    expect(readTrustedDevelopmentClientAddress(headers, undefined)).toBeUndefined();
    expect(readTrustedDevelopmentClientAddress(headers, "")).toBeUndefined();
  });

  it("compares strings without length leakage", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStrings("", "x")).toBe(false);
  });
});

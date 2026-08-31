import { describe, expect, it } from "vitest";

import { readForwardedAudienceBaggage, writeForwardedAudienceBaggage } from "#protocol/baggage.js";

describe("readForwardedAudienceBaggage", () => {
  it("reads one public Eve audience member among unrelated baggage", () => {
    expect(readForwardedAudienceBaggage("vendor=value,eve.audience=public")).toBe("public");
  });

  it.each([null, "vendor=value"])("returns absent for %s", (value) => {
    expect(readForwardedAudienceBaggage(value)).toBe("absent");
  });

  it.each([
    "eve.audience=private",
    "eve.audience=unknown",
    "eve.audience=public,eve.audience=public",
    "eve.audience=public;property=yes",
    "eve.audience=public;bad property",
    "eve.audience",
  ])("fails closed for malformed Eve baggage %s", (value) => {
    expect(readForwardedAudienceBaggage(value)).toBe("malformed");
  });
});

describe("writeForwardedAudienceBaggage", () => {
  it("preserves unrelated entries and overwrites authored Eve audience", () => {
    expect(writeForwardedAudienceBaggage("first=1,eve.audience=private,second=2", "public")).toBe(
      "first=1,second=2,eve.audience=public",
    );
  });

  it("removes malformed authored Eve audience members", () => {
    expect(writeForwardedAudienceBaggage("eve.audience,vendor=value", "public")).toBe(
      "vendor=value,eve.audience=public",
    );
    expect(writeForwardedAudienceBaggage("eve.audience;property=x,vendor=value", "public")).toBe(
      "vendor=value,eve.audience=public",
    );
  });

  it("removes authored Eve audience when the parent is not public", () => {
    expect(writeForwardedAudienceBaggage("eve.audience=public,vendor=value", "unknown")).toBe(
      "vendor=value",
    );
    expect(writeForwardedAudienceBaggage("eve.audience=public", "unknown")).toBeUndefined();
  });
});

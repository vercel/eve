import { describe, expect, it } from "vitest";

import { readForwardedAudienceBaggage, writeForwardedAudienceBaggage } from "#protocol/baggage.js";

const PUBLIC_OUTPUTS = {
  ceiling: { recordInputs: false, recordOutputs: true },
  originAudience: "public",
} as const;

describe("readForwardedAudienceBaggage", () => {
  it.each([
    ["public", true, true],
    ["private", true, false],
    ["unknown", false, false],
  ] as const)("reads a %s origin audience with its ceiling", (originAudience, inputs, outputs) => {
    expect(
      readForwardedAudienceBaggage(
        `vendor=value,eve.audience=${originAudience};ceiling=i${inputs ? "1" : "0"}o${outputs ? "1" : "0"}`,
      ),
    ).toEqual({
      ceiling: { recordInputs: inputs, recordOutputs: outputs },
      originAudience,
    });
  });

  it("accepts W3C optional whitespace around separators", () => {
    expect(
      readForwardedAudienceBaggage(
        "vendor=value\t,\t eve.audience \t=\t private \t;\t ceiling \t=\t i1o0 \t",
      ),
    ).toEqual({
      ceiling: { recordInputs: true, recordOutputs: false },
      originAudience: "private",
    });
  });

  it.each([null, "vendor=value", "eve.capture=i1o1"])('returns absent for "%s"', (value) => {
    expect(readForwardedAudienceBaggage(value)).toBe("absent");
  });

  it.each([
    "eve.audience=public",
    "eve.audience=private",
    "eve.audience=public,eve.audience=public;ceiling=i1o1",
    "eve.audience=public;ceiling=i1o1,eve.audience=private;ceiling=i0o0",
    "eve.audience=public;ceiling=i1o1;vendor=yes",
    "eve.audience=public;vendor=yes",
    "eve.audience=public;ceiling=i1o1;ceiling=i0o0",
    "eve.audience=public;ceiling=i2o1",
    "eve.audience=public;ceiling=o1i1",
    "eve.audience=public;ceiling=drop",
    "eve.audience=everyone;ceiling=i1o1",
    "eve.audience=public;ceiling",
    "eve.audience=public;bad property=i1o1",
    "eve.audience",
    "eve.audience=public;ceiling=i1o1\n",
    "eve.audience=public;\vceiling=i1o1",
    "eve.audience=public;\fceiling=i1o1",
    "eve.audience=public;\u00a0ceiling=i1o1",
  ])("fails closed for malformed Eve baggage %s", (value) => {
    expect(readForwardedAudienceBaggage(value)).toBe("malformed");
  });
});

describe("writeForwardedAudienceBaggage", () => {
  it("preserves unrelated entries and replaces authored Eve assertions", () => {
    expect(
      writeForwardedAudienceBaggage(
        "first=1,eve.audience=private;ceiling=i1o1,second=2",
        PUBLIC_OUTPUTS,
      ),
    ).toBe("first=1,second=2,eve.audience=public;ceiling=i0o1");
    expect(
      writeForwardedAudienceBaggage("eve.audience=public,eve.capture=i1o1", PUBLIC_OUTPUTS),
    ).toBe("eve.capture=i1o1,eve.audience=public;ceiling=i0o1");
  });

  it("removes malformed authored Eve audience members", () => {
    expect(writeForwardedAudienceBaggage("eve.audience,vendor=value", PUBLIC_OUTPUTS)).toBe(
      "vendor=value,eve.audience=public;ceiling=i0o1",
    );
    expect(
      writeForwardedAudienceBaggage("eve.audience;property=x,vendor=value", PUBLIC_OUTPUTS),
    ).toBe("vendor=value,eve.audience=public;ceiling=i0o1");
  });

  it("removes authored Eve assertions when there is no sampled record decision", () => {
    expect(
      writeForwardedAudienceBaggage("eve.audience=public;ceiling=i1o1,vendor=value", undefined),
    ).toBe("vendor=value");
    expect(
      writeForwardedAudienceBaggage("eve.audience=public;ceiling=i1o1", undefined),
    ).toBeUndefined();
  });
});

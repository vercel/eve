import { describe, expect, it } from "vitest";

import {
  pickDeclaredFields,
  resolveFieldSpecs,
  WireFieldError,
  type FieldTable,
} from "#execution/wire/field-table.js";

const TABLE: FieldTable = {
  control: {},
  deliver: {
    auth: "object-or-null?",
    caller: "object?",
    payloads: "object[]",
    requestId: "string?",
    turnPolicy: "turn-policy?",
  },
};

describe("resolveFieldSpecs", () => {
  it("resolves a known discriminator", () => {
    expect(resolveFieldSpecs({ discriminator: "control", label: "L", table: TABLE })).toEqual({});
  });

  it.each([
    ["unknown", "mystery"],
    ["non-string", 7],
    ["absent", undefined],
  ])("throws naming the legal values for a %s discriminator", (_name, discriminator) => {
    expect(() => resolveFieldSpecs({ discriminator, label: "L", table: TABLE })).toThrowError(
      /unrecognized kind .*expected control \| deliver/,
    );
  });

  it("does not resolve inherited object properties as discriminators", () => {
    // A payload with `kind: "toString"` must not resolve Object.prototype.
    expect(() =>
      resolveFieldSpecs({ discriminator: "toString", label: "L", table: TABLE }),
    ).toThrowError(WireFieldError);
  });
});

describe("pickDeclaredFields", () => {
  const pick = (value: Record<string, unknown>, specs = TABLE.deliver!) =>
    pickDeclaredFields({ label: "L", specs, value });

  it("copies declared fields and omits undeclared ones", () => {
    const payloads = [{ message: "a" }];
    expect(pick({ payloads, requestId: "r", stowaway: "dropped" })).toEqual({
      payloads,
      requestId: "r",
    });
  });

  it("copies declared values by reference so aliasing survives", () => {
    const payloads = [{ message: "a" }];
    expect(pick({ payloads }).payloads).toBe(payloads);
  });

  it("omits absent optional fields rather than writing undefined", () => {
    const picked = pick({ payloads: [] });
    expect(Object.keys(picked)).toEqual(["payloads"]);
  });

  it("throws when a required field is absent", () => {
    expect(() => pick({ requestId: "r" })).toThrowError(/missing required field "payloads"/);
  });

  it.each([
    ["object[]", "payloads", "not-an-array"],
    ["object[]", "payloads", [1]],
    ["string", "requestId", 7],
    ["object", "caller", "nope"],
    ["object-or-null", "auth", 7],
    ["turn-policy", "turnPolicy", "interrupt"],
  ])("throws when a %s field is the wrong type", (type, field, bad) => {
    expect(() => pick({ payloads: [], [field]: bad })).toThrowError(
      new RegExp(`field "${field}" is not ${type.replace(/[[\]]/g, "\\$&")}`),
    );
  });

  it.each([
    ["null", null],
    ["an object", { a: 1 }],
  ])("accepts %s for an object-or-null field", (_name, auth) => {
    expect(pick({ auth, payloads: [] })).toEqual({ auth, payloads: [] });
  });

  it("accepts an empty array for an object[] field", () => {
    expect(pick({ payloads: [] })).toEqual({ payloads: [] });
  });

  it.each(["queue", "steer"])("accepts %s as a turn policy", (turnPolicy) => {
    expect(pick({ payloads: [], turnPolicy })).toEqual({ payloads: [], turnPolicy });
  });
});

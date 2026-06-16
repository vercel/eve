import { describe, expect, it } from "vitest";

import {
  normalizeAuthorizationSpec,
  validateAuthorizationSpec,
} from "#runtime/connections/validate-authorization.js";

const getToken = async () => ({ token: "abc" });
const startAuthorization = async () => ({
  challenge: { url: "https://idp.example/auth" },
  state: { authorizationId: "x" },
});
const completeAuthorization = async () => ({ token: "fresh" });

describe("validateAuthorizationSpec", () => {
  describe("happy path", () => {
    it("returns undefined for a getToken-only app-scoped definition", () => {
      expect(validateAuthorizationSpec({ getToken, principalType: "app" })).toBeUndefined();
    });

    it("returns undefined for a getToken-only user-scoped definition", () => {
      expect(validateAuthorizationSpec({ getToken, principalType: "user" })).toBeUndefined();
    });

    it("returns undefined for a getToken-only definition without principalType", () => {
      expect(validateAuthorizationSpec({ getToken })).toBeUndefined();
    });

    it("returns undefined for a full three-method user-scoped definition", () => {
      expect(
        validateAuthorizationSpec({
          completeAuthorization,
          getToken,
          principalType: "user",
          startAuthorization,
        }),
      ).toBeUndefined();
    });
  });

  describe("object-shape rejection", () => {
    it("rejects null", () => {
      expect(validateAuthorizationSpec(null)).toMatch(/must be an object with a "getToken" method/);
    });

    it("rejects a primitive", () => {
      expect(validateAuthorizationSpec("token")).toMatch(
        /must be an object with a "getToken" method/,
      );
    });
  });

  describe("principalType rejection", () => {
    it("rejects an unknown principalType value", () => {
      expect(validateAuthorizationSpec({ getToken, principalType: "service" })).toMatch(
        /"auth\.principalType" field must be "app" or "user"/,
      );
    });
  });

  describe("getToken rejection", () => {
    it("rejects a missing getToken", () => {
      expect(validateAuthorizationSpec({ principalType: "app" })).toMatch(
        /"auth\.getToken" field must be a function/,
      );
    });

    it("rejects a non-function getToken", () => {
      expect(
        validateAuthorizationSpec({ getToken: "not a function", principalType: "app" }),
      ).toMatch(/"auth\.getToken" field must be a function/);
    });
  });

  describe("both-or-neither rejection", () => {
    it("rejects startAuthorization without completeAuthorization", () => {
      expect(
        validateAuthorizationSpec({ getToken, principalType: "user", startAuthorization }),
      ).toMatch(/both "startAuthorization" and "completeAuthorization"/);
    });

    it("rejects completeAuthorization without startAuthorization", () => {
      expect(
        validateAuthorizationSpec({ completeAuthorization, getToken, principalType: "user" }),
      ).toMatch(/both "startAuthorization" and "completeAuthorization"/);
    });

    it("rejects a non-function startAuthorization", () => {
      expect(
        validateAuthorizationSpec({
          completeAuthorization,
          getToken,
          principalType: "user",
          startAuthorization: "nope",
        }),
      ).toMatch(/"auth\.startAuthorization" field must be a function/);
    });

    it("rejects a non-function completeAuthorization", () => {
      expect(
        validateAuthorizationSpec({
          completeAuthorization: "nope",
          getToken,
          principalType: "user",
          startAuthorization,
        }),
      ).toMatch(/"auth\.completeAuthorization" field must be a function/);
    });
  });

  describe("interactive-app rejection", () => {
    it("rejects interactive OAuth with principalType: app", () => {
      expect(
        validateAuthorizationSpec({
          completeAuthorization,
          getToken,
          principalType: "app",
          startAuthorization,
        }),
      ).toMatch(/Interactive authorization .* restricted to "principalType": "user"/);
    });
  });

  describe("displayName validation", () => {
    it("accepts a non-empty string displayName", () => {
      expect(validateAuthorizationSpec({ displayName: "Salesforce", getToken })).toBeUndefined();
    });

    it("rejects a non-string displayName", () => {
      expect(validateAuthorizationSpec({ displayName: 42, getToken })).toMatch(
        /"auth\.displayName" field must be a non-empty string/,
      );
    });

    it("rejects an empty displayName", () => {
      expect(validateAuthorizationSpec({ displayName: "", getToken })).toMatch(
        /"auth\.displayName" field must be a non-empty string/,
      );
    });
  });
});

describe("normalizeAuthorizationSpec", () => {
  it('defaults getToken-only auth to principalType "app"', () => {
    expect(normalizeAuthorizationSpec({ getToken }, "testPrefix:")).toMatchObject({
      getToken,
      principalType: "app",
    });
  });

  it("preserves explicit getToken-only principalType", () => {
    expect(
      normalizeAuthorizationSpec({ getToken, principalType: "user" }, "testPrefix:"),
    ).toMatchObject({
      getToken,
      principalType: "user",
    });
  });

  it("carries displayName through the non-interactive branch", () => {
    expect(
      normalizeAuthorizationSpec({ displayName: "Salesforce", getToken }, "testPrefix:"),
    ).toMatchObject({
      displayName: "Salesforce",
      principalType: "app",
    });
  });

  it("carries displayName through the interactive branch", () => {
    expect(
      normalizeAuthorizationSpec(
        {
          completeAuthorization,
          displayName: "Salesforce",
          getToken,
          principalType: "user",
          startAuthorization,
        },
        "testPrefix:",
      ),
    ).toMatchObject({
      displayName: "Salesforce",
      principalType: "user",
    });
  });

  it("omits displayName when not authored", () => {
    expect(normalizeAuthorizationSpec({ getToken }, "testPrefix:")).not.toHaveProperty(
      "displayName",
    );
  });

  it("throws on an invalid displayName", () => {
    expect(() => normalizeAuthorizationSpec({ displayName: "", getToken }, "testPrefix:")).toThrow(
      /"auth\.displayName" field must be a non-empty string/,
    );
  });
});

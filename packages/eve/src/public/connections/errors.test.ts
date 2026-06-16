import { describe, expect, it } from "vitest";

import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";

describe("ConnectionAuthorizationRequiredError", () => {
  it("sets name and connectionName", () => {
    const error = new ConnectionAuthorizationRequiredError("linear");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConnectionAuthorizationRequiredError);
    expect(error.name).toBe("ConnectionAuthorizationRequiredError");
    expect(error.connectionName).toBe("linear");
    expect(error.message).toBe('Connection "linear" requires authorization.');
  });

  it("accepts a custom message", () => {
    const error = new ConnectionAuthorizationRequiredError("github", {
      message: "OAuth token not found",
    });

    expect(error.connectionName).toBe("github");
    expect(error.message).toBe("OAuth token not found");
  });
});

describe("ConnectionAuthorizationFailedError", () => {
  it("sets name and connectionName with retryable default", () => {
    const error = new ConnectionAuthorizationFailedError("slack");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConnectionAuthorizationFailedError);
    expect(error.name).toBe("ConnectionAuthorizationFailedError");
    expect(error.connectionName).toBe("slack");
    expect(error.message).toBe('Connection "slack" authorization failed.');
    expect(error.reason).toBeUndefined();
    expect(error.retryable).toBe(true);
  });

  it("accepts a custom message", () => {
    const error = new ConnectionAuthorizationFailedError("jira", {
      message: "OIDC issuer unreachable",
    });

    expect(error.connectionName).toBe("jira");
    expect(error.message).toBe("OIDC issuer unreachable");
  });

  it("surfaces reason when provided (free-form observability field)", () => {
    const error = new ConnectionAuthorizationFailedError("github", {
      reason: "idp_code_reused",
    });

    expect(error.reason).toBe("idp_code_reused");
    expect(error.retryable).toBe(true);
  });

  it("supports access_denied as the canonical terminal user-cancel signal", () => {
    const error = new ConnectionAuthorizationFailedError("github", {
      message: "User denied authorization.",
      reason: "access_denied",
      retryable: false,
    });

    expect(error.message).toBe("User denied authorization.");
    expect(error.reason).toBe("access_denied");
    expect(error.retryable).toBe(false);
  });
});

describe("isConnectionAuthorizationRequiredError", () => {
  it("returns true for matching instances", () => {
    expect(
      isConnectionAuthorizationRequiredError(new ConnectionAuthorizationRequiredError("linear")),
    ).toBe(true);
  });

  it("returns true for look-alike errors (dual-instance hazard)", () => {
    const fake = new Error("...");
    fake.name = "ConnectionAuthorizationRequiredError";
    expect(isConnectionAuthorizationRequiredError(fake)).toBe(true);
  });

  it("returns false for other error types", () => {
    expect(isConnectionAuthorizationRequiredError(new Error("generic"))).toBe(false);
    expect(
      isConnectionAuthorizationRequiredError(new ConnectionAuthorizationFailedError("slack")),
    ).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isConnectionAuthorizationRequiredError(undefined)).toBe(false);
    expect(isConnectionAuthorizationRequiredError("string")).toBe(false);
    expect(
      isConnectionAuthorizationRequiredError({
        name: "ConnectionAuthorizationRequiredError",
      }),
    ).toBe(false);
  });
});

describe("isConnectionAuthorizationFailedError", () => {
  it("returns true for matching instances", () => {
    expect(
      isConnectionAuthorizationFailedError(new ConnectionAuthorizationFailedError("linear")),
    ).toBe(true);
  });

  it("returns true for look-alike errors", () => {
    const fake = new Error("...");
    fake.name = "ConnectionAuthorizationFailedError";
    expect(isConnectionAuthorizationFailedError(fake)).toBe(true);
  });

  it("returns false for other error types", () => {
    expect(isConnectionAuthorizationFailedError(new Error("generic"))).toBe(false);
    expect(
      isConnectionAuthorizationFailedError(new ConnectionAuthorizationRequiredError("slack")),
    ).toBe(false);
  });
});

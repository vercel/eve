import { describe, expect, it } from "vitest";

import { ClientError } from "#client/client-error.js";

describe("ClientError", () => {
  it("uses structured eve JSON error bodies as the public message", () => {
    const error = new ClientError(
      401,
      JSON.stringify({
        code: "eve_production_auth_not_configured",
        error: "Production auth is not configured.",
        ok: false,
      }),
    );

    expect(error.message).toBe("Production auth is not configured.");
    expect(error.status).toBe(401);
  });

  it("falls back to the raw body for non-JSON errors", () => {
    const error = new ClientError(500, "Internal Server Error");

    expect(error.message).toBe("Internal Server Error");
  });
});

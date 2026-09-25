import { describe, expect, it } from "vitest";

import {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
} from "./auth.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

describe("Codex token metadata", () => {
  it("reads JWT expiry without exposing token contents", () => {
    const token = createUnsignedJwt({ exp: 1_783_405_980 });

    expect(readCodexJwtExpirationMs(token)).toBe(1_783_405_980_000);
    expect(readCodexJwtExpirationMs("not.jwt")).toBeUndefined();
  });

  it("reads a human account label from explicit email or an email-shaped subject suffix", () => {
    expect(
      extractCodexAccountLabelFromToken(createUnsignedJwt({ email: "user@example.com" })),
    ).toBe("user@example.com");
    expect(
      extractCodexAccountLabelFromToken(
        createUnsignedJwt({ sub: "samlp|profile-id|person@example.com" }),
      ),
    ).toBe("person@example.com");
    expect(
      extractCodexAccountLabelFromToken(createUnsignedJwt({ sub: "opaque-user-id" })),
    ).toBeUndefined();
  });

  it("reads the ChatGPT account from supported claim shapes", () => {
    expect(
      extractCodexAccountIdFromToken(createUnsignedJwt({ chatgpt_account_id: "acct-direct" })),
    ).toBe("acct-direct");
    expect(
      extractCodexAccountIdFromToken(
        createUnsignedJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-auth" },
        }),
      ),
    ).toBe("acct-auth");
    expect(
      extractCodexAccountIdFromToken(
        createUnsignedJwt({ organizations: [{ id: "acct-organization" }] }),
      ),
    ).toBe("acct-organization");
  });
});

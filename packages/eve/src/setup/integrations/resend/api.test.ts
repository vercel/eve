import { describe, expect, it, vi } from "vitest";

import {
  createResendWebhook,
  listResendWebhooks,
  sameResendEndpoint,
  suggestResendFromAddress,
  validateResendApiKey,
} from "./api.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Resend API", () => {
  it("validates and lists webhooks without putting the key in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ data: [] }));
    await validateResendApiKey("re_secret", undefined, { fetch });
    await listResendWebhooks("re_secret", undefined, { fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.resend.com/webhooks");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer re_secret" },
    });
  });

  it("suggests eve on a custom receiving domain before the default Resend domain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        data: [
          {
            name: "phipelaan.resend.app",
            capabilities: { sending: "enabled", receiving: "enabled" },
          },
          {
            name: "example.com",
            capabilities: { sending: "enabled", receiving: "enabled" },
          },
          {
            name: "send-only.example",
            capabilities: { sending: "enabled", receiving: "disabled" },
          },
        ],
      }),
    );

    await expect(suggestResendFromAddress("re_secret", undefined, { fetch })).resolves.toBe(
      "eve@example.com",
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.resend.com/domains");
  });

  it("does not suggest the managed receiving-only Resend domain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        data: [
          {
            name: "phipelaan.resend.app",
            capabilities: { sending: "enabled", receiving: "enabled" },
          },
        ],
      }),
    );

    await expect(
      suggestResendFromAddress("re_secret", undefined, { fetch }),
    ).resolves.toBeUndefined();
  });

  it("creates only an email.received webhook", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        data: {
          id: "wh_1",
          endpoint: "https://agent.test/eve/v1/resend",
          events: ["email.received"],
          signing_secret: "whsec_secret",
        },
      }),
    );
    await expect(
      createResendWebhook("re_secret", "https://agent.test/eve/v1/resend", undefined, { fetch }),
    ).resolves.toMatchObject({ id: "wh_1", signing_secret: "whsec_secret" });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ endpoint: "https://agent.test/eve/v1/resend", events: ["email.received"] }),
    );
  });

  it("normalizes exact endpoints without matching other paths", () => {
    expect(
      sameResendEndpoint("https://agent.test/eve/v1/resend/", "https://agent.test/eve/v1/resend"),
    ).toBe(true);
    expect(
      sameResendEndpoint(
        "https://agent.test/eve/v1/resend-old",
        "https://agent.test/eve/v1/resend",
      ),
    ).toBe(false);
  });

  it("returns an actionable authentication error without the key", async () => {
    await expect(
      validateResendApiKey("re_secret", undefined, {
        fetch: async () => response({ message: "bad" }, 401),
      }),
    ).rejects.toThrow("full-access key");
  });
});

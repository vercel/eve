import { describe, expect, it, vi } from "vitest";

import {
  deleteMarketplaceResendWebhooks,
  reconcileMarketplaceResendWebhook,
} from "./marketplace-webhook.js";

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

describe("Resend Marketplace webhook setup", () => {
  it("reconciles an email.received webhook with the temporary OAuth token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          data: [
            { id: "wh_old", endpoint: "https://agent.test/eve/v1/resend/" },
            { id: "wh_other", endpoint: "https://other.test/webhook" },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ id: "wh_new", signing_secret: "whsec_new" }));

    await expect(
      reconcileMarketplaceResendWebhook({
        accessToken: "oauth_secret",
        endpoint: "https://agent.test/eve/v1/resend",
        deps: { fetch },
      }),
    ).resolves.toEqual({
      id: "wh_new",
      signingSecret: "whsec_new",
      previousIds: ["wh_old"],
    });

    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer oauth_secret" },
    });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        endpoint: "https://agent.test/eve/v1/resend",
        events: ["email.received"],
      }),
    );
  });

  it("deletes webhooks without putting the OAuth token in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(undefined, 204));
    await deleteMarketplaceResendWebhooks({
      accessToken: "oauth_secret",
      ids: ["wh_old"],
      deps: { fetch },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.resend.com/webhooks/wh_old");
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("oauth_secret");
  });
});

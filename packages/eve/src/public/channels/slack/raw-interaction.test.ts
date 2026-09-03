import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRawInteraction } from "#public/channels/slack/raw-interaction.js";

const fallback = () => new Response("ok", { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

function rawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "view_submission",
    team: { id: "T_INSTALLATION" },
    user: { id: "U01", username: "ada", team_id: "T_ACTOR" },
    enterprise: { id: "E_NESTED" },
    ...overrides,
  };
}

describe("handleRawInteraction", () => {
  it("passes through the payload with normalized interaction identity", async () => {
    const payload = rawPayload();
    const handler = vi.fn(() => Response.json({ response_action: "clear" }));

    const response = await handleRawInteraction(
      payload,
      "unsupported",
      vi.fn(),
      { onRawInteraction: handler },
      fallback(),
    );

    await expect(response.json()).resolves.toEqual({ response_action: "clear" });
    expect(handler).toHaveBeenCalledWith(
      {
        type: "view_submission",
        payload,
        user: { id: "U01", username: "ada", name: undefined },
        teamId: "T_ACTOR",
        installationTeamId: "T_INSTALLATION",
        enterpriseId: "E_NESTED",
      },
      expect.objectContaining({ slack: expect.any(Object), waitUntil: expect.any(Function) }),
    );
  });

  it("prefers nested installation and enterprise identity fields for API access", async () => {
    const botToken = vi.fn(() => "xoxb-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ ok: true }))),
    );

    await handleRawInteraction(
      rawPayload({
        app_installed_team_id: "T_TOP_LEVEL",
        enterprise_id: "E_TOP_LEVEL",
        view: { app_installed_team_id: "T_VIEW" },
      }),
      "view_submission",
      vi.fn(),
      {
        credentials: { botToken },
        async onRawInteraction(interaction, ctx) {
          expect(interaction).toMatchObject({
            installationTeamId: "T_VIEW",
            enterpriseId: "E_NESTED",
          });
          await ctx.slack.request("auth.test", {});
        },
      },
      fallback(),
    );

    expect(botToken).toHaveBeenCalledWith({ teamId: "T_VIEW" });
  });

  it("reads top-level enterprise identity when the nested field is absent", async () => {
    const handler = vi.fn();

    await handleRawInteraction(
      rawPayload({ enterprise: undefined, enterprise_id: "E_TOP_LEVEL" }),
      "view_submission",
      vi.fn(),
      { onRawInteraction: handler },
      fallback(),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: "E_TOP_LEVEL" }),
      expect.any(Object),
    );
  });

  it("preserves absent optional identity fields", async () => {
    const handler = vi.fn();

    await handleRawInteraction(
      { type: "view_closed", view: {} },
      "view_closed",
      vi.fn(),
      { onRawInteraction: handler },
      fallback(),
    );

    expect(handler).toHaveBeenCalledWith(
      {
        type: "view_closed",
        payload: { type: "view_closed", view: {} },
        user: undefined,
        teamId: undefined,
        installationTeamId: undefined,
        enterpriseId: undefined,
      },
      expect.any(Object),
    );
  });

  it("returns an empty acknowledgement when the handler returns void", async () => {
    const response = await handleRawInteraction(
      rawPayload(),
      "view_submission",
      vi.fn(),
      { onRawInteraction: vi.fn() },
      fallback(),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("returns the fallback acknowledgement when the handler throws", async () => {
    const response = await handleRawInteraction(
      rawPayload(),
      "view_submission",
      vi.fn(),
      {
        onRawInteraction() {
          throw new Error("failed");
        },
      },
      fallback(),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("does not invoke the handler for a non-object payload", async () => {
    const handler = vi.fn();

    const response = await handleRawInteraction(
      "invalid",
      "unsupported",
      vi.fn(),
      { onRawInteraction: handler },
      fallback(),
    );

    expect(handler).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("ok");
  });
});

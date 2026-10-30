import { describe, expect, it, vi } from "vitest";

import {
  configureDiscordInteractionsEndpoint,
  enableDiscordMessageContentIntent,
  registerDiscordCommand,
  resolveDiscordApplication,
} from "./api.js";

describe("Discord setup API", () => {
  it("resolves application metadata from a bot token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "app-1", name: "Agent", verify_key: "public-key" }),
    ) as typeof fetch;

    await expect(resolveDiscordApplication("bot-token", fetchImpl)).resolves.toEqual({
      id: "app-1",
      name: "Agent",
      publicKey: "public-key",
    });
  });

  it("registers the default message command shape", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "command-1" })) as typeof fetch;

    await registerDiscordCommand(
      "app-1",
      "bot-token",
      { name: "ask", description: "Ask the eve agent" },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/applications/app-1/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "ask",
          description: "Ask the eve agent",
          type: 1,
          options: [
            {
              name: "message",
              description: "What should the agent do?",
              type: 3,
              required: true,
            },
            {
              name: "file",
              description: "A file for the agent to read",
              type: 11,
              required: false,
            },
          ],
        }),
      }),
    );
  });

  it("sets the Connect interaction callback URL", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "app-1" })) as typeof fetch;

    await configureDiscordInteractionsEndpoint("bot-token", "scl_discord", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/applications/@me",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          interactions_endpoint_url: "https://connect.vercel.com/trigger/scl_discord",
        }),
      }),
    );
  });

  describe("enableDiscordMessageContentIntent", () => {
    function discordApp(flags: number, patchStatus = 200) {
      return vi.fn<typeof fetch>(async (_url, init) =>
        init?.method === "PATCH"
          ? new Response("{}", { status: patchStatus })
          : Response.json({ flags }),
      );
    }

    it("turns on the limited intent and keeps the other limited intents set", async () => {
      // Limited guild members (1 << 15) set, plus an unrelated read-only flag (1 << 23).
      const fetchImpl = discordApp((1 << 15) | (1 << 23));

      await expect(enableDiscordMessageContentIntent("bot-token", fetchImpl)).resolves.toBe(true);

      expect(fetchImpl).toHaveBeenLastCalledWith(
        "https://discord.com/api/v10/applications/@me",
        expect.objectContaining({
          body: JSON.stringify({ flags: (1 << 15) | (1 << 19) }),
          method: "PATCH",
        }),
      );
    });

    it("leaves an app whose Message Content intent is already approved alone", async () => {
      const fetchImpl = discordApp(1 << 18);

      await expect(enableDiscordMessageContentIntent("bot-token", fetchImpl)).resolves.toBe(true);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a refusal, as for a verified app that needs approval", async () => {
      await expect(
        enableDiscordMessageContentIntent("bot-token", discordApp(0, 403)),
      ).resolves.toBe(false);
    });
  });
});

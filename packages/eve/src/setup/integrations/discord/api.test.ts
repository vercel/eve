import { describe, expect, it, vi } from "vitest";

import {
  configureDiscordInteractionsEndpoint,
  registerDiscordCommand,
  resolveDiscordApplication,
} from "./api.js";

describe("Discord setup API", () => {
  it("resolves application metadata from a bot token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "app-1", name: "Agent", verify_key: "public-key" }),
    ) as unknown as typeof fetch;

    await expect(resolveDiscordApplication("bot-token", fetchImpl)).resolves.toEqual({
      id: "app-1",
      name: "Agent",
      publicKey: "public-key",
    });
  });

  it("registers the default message command shape", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "command-1" }),
    ) as unknown as typeof fetch;

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
          ],
        }),
      }),
    );
  });

  it("sets the Connect interaction callback URL", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "app-1" })) as unknown as typeof fetch;

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
});

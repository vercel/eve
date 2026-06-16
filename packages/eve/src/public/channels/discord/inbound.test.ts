import { describe, expect, it } from "vitest";

import {
  commandInteractionMessage,
  formatDiscordContextBlock,
  parseDiscordInteraction,
} from "#public/channels/discord/inbound.js";

describe("parseDiscordInteraction", () => {
  it("parses an application command interaction", () => {
    const interaction = parseDiscordInteraction({
      application_id: "APP1",
      channel_id: "C01",
      data: {
        id: "CMD1",
        name: "ask",
        options: [{ name: "message", type: 3, value: "hello from discord" }],
      },
      guild_id: "G01",
      id: "I01",
      member: {
        nick: "Ada",
        roles: ["R01"],
        user: { id: "U01", username: "ada", global_name: "Ada Lovelace" },
      },
      token: "tok",
      type: 2,
      version: 1,
    });

    expect(interaction?.type).toBe(2);
    if (interaction?.type !== 2) throw new Error("Expected command interaction.");
    expect(interaction.commandName).toBe("ask");
    expect(interaction.options).toEqual([
      { name: "message", options: [], value: "hello from discord" },
    ]);
    expect(interaction.user).toMatchObject({
      globalName: "Ada Lovelace",
      id: "U01",
      username: "ada",
    });
    expect(interaction.member?.nick).toBe("Ada");
  });

  it("parses a message component interaction", () => {
    const interaction = parseDiscordInteraction({
      application_id: "APP1",
      channel_id: "C01",
      data: { component_type: 2, custom_id: "custom", values: ["approve"] },
      id: "I02",
      message: { id: "M01" },
      token: "tok",
      type: 3,
      user: { id: "U01", username: "ada" },
      version: 1,
    });

    expect(interaction?.type).toBe(3);
    if (interaction?.type !== 3) throw new Error("Expected component interaction.");
    expect(interaction.messageId).toBe("M01");
    expect(interaction.values).toEqual(["approve"]);
  });

  it("parses text inputs from a modal submission", () => {
    const interaction = parseDiscordInteraction({
      application_id: "APP1",
      channel_id: "C01",
      data: {
        custom_id: "modal",
        components: [
          {
            components: [{ custom_id: "answer", value: "freeform text" }],
            type: 1,
          },
        ],
      },
      id: "I03",
      message: { id: "M01" },
      token: "tok",
      type: 5,
      user: { id: "U01", username: "ada" },
      version: 1,
    });

    expect(interaction?.type).toBe(5);
    if (interaction?.type !== 5) throw new Error("Expected modal interaction.");
    expect(interaction.textInputs).toEqual({ answer: "freeform text" });
  });

  it("returns null for unsupported or incomplete interactions", () => {
    expect(parseDiscordInteraction({ type: 1 })).toBeNull();
    expect(parseDiscordInteraction({ type: 2, data: { name: "ask" } })).toBeNull();
  });
});

describe("commandInteractionMessage", () => {
  it("prefers a string option named message", () => {
    const interaction = parseDiscordInteraction({
      application_id: "APP1",
      channel_id: "C01",
      data: {
        name: "ask",
        options: [{ name: "message", value: "exact prompt" }],
      },
      id: "I01",
      token: "tok",
      type: 2,
      user: { id: "U01", username: "ada" },
    });
    if (interaction?.type !== 2) throw new Error("Expected command interaction.");

    expect(commandInteractionMessage(interaction)).toBe("exact prompt");
  });

  it("falls back to a deterministic command summary", () => {
    const interaction = parseDiscordInteraction({
      application_id: "APP1",
      channel_id: "C01",
      data: {
        name: "lookup",
        options: [
          {
            name: "city",
            value: "Brooklyn",
          },
          {
            name: "units",
            value: "metric",
          },
        ],
      },
      id: "I01",
      token: "tok",
      type: 2,
      user: { id: "U01", username: "ada" },
    });
    if (interaction?.type !== 2) throw new Error("Expected command interaction.");

    expect(commandInteractionMessage(interaction)).toBe("/lookup city:Brooklyn units:metric");
  });
});

describe("Discord context rendering", () => {
  it("renders a deterministic context block", () => {
    const block = formatDiscordContextBlock({
      channelId: "C01",
      commandName: "ask",
      guildId: "G01",
      interactionId: "I01",
      userId: "U01",
      username: "ada",
    });
    expect(block).toContain("<discord_context>");
    expect(block).toContain("user_id: U01");
    expect(block).toContain("username: ada");
  });
});

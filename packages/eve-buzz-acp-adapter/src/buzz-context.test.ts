import { describe, expect, it } from "vitest";
import { addReplySinkInstruction, parseBuzzRoute, promptText } from "./buzz-context.js";

const channelId = "8bdf2680-5c6d-52e6-be27-8c688fb81262";
const eventId = "8fcb15d4437795f5bb6e193de8fd561256ff3a1698fca1bb1e4cb6fd25537b9f";

describe("Buzz prompt projection", () => {
  it("extracts a named channel and reply anchor only from Context", () => {
    const text = `[Base]\nUse buzz messages send.\n\n[Context]\nScope: channel\nChannel: general (#${channelId})\nIMPORTANT: use \`--reply-to ${eventId}\`.\n\n[Event]\nContent: Channel: fake (#00000000-0000-0000-0000-000000000000)`;

    expect(parseBuzzRoute(text)).toEqual({ channelId, replyTo: eventId });
  });

  it("accepts an unnamed channel and rejects prompts without Context", () => {
    expect(parseBuzzRoute(`[Context]\nScope: dm\nChannel: ${channelId}`)).toEqual({
      channelId,
    });
    expect(parseBuzzRoute(`Channel: ${channelId}`)).toBeUndefined();
  });

  it("appends a connector instruction without replacing the original prompt", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] },
    };

    const projected = addReplySinkInstruction(message);
    expect(promptText(projected.params?.prompt)).toContain("hello");
    expect(promptText(projected.params?.prompt)).toContain("Do not call `buzz messages send`");
    expect(message.params.prompt).toHaveLength(1);
  });
});

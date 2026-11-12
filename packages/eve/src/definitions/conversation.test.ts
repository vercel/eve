import { describe, expect, it } from "vitest";

import { conversationSpaceNote } from "#definitions/conversation.js";
import { stepSystem } from "#definitions/step.js";
import { beforeModelCall, definitionSession } from "#internal/testing/definition-session.js";
import { ConversationContextKey, type ConversationSpace } from "#shared/conversation-context.js";

async function systemParts(space?: ConversationSpace): Promise<readonly string[]> {
  const { ctx } = definitionSession();
  ctx.set(ConversationContextKey, {
    audience: "private",
    channel: { kind: "channel:slack", name: "slack" },
    environment: "production",
    principalType: "user",
    ...(space !== undefined && { space }),
  });
  await beforeModelCall(ctx);
  const prompt = await stepSystem({
    config: { tools: new Map() },
    ctx,
    finalReplyOnly: false,
    session: {},
  });
  return typeof prompt === "string" ? [prompt] : prompt;
}

describe("conversation space note", () => {
  it("tells the model the space's type and visibility, in a part after the shared prompt", async () => {
    const parts = await systemParts({
      id: "slack:T1:C1",
      type: "channel",
      visibility: "private",
      workspaceId: "slack:T1",
    });

    expect(parts.slice(1)).toContain(
      [
        "<conversation_space>",
        "type: channel",
        "visibility: private",
        "</conversation_space>",
        "This conversation is a channel that people join. Only its members can see it.",
      ].join("\n"),
    );
    expect(parts.join("\n")).not.toContain("slack:T1:C1");
  });

  it("says when visibility is unknown, rather than leaving it out", () => {
    expect(conversationSpaceNote({ id: "teams:t:c", type: "channel" })).toContain(
      "visibility: unknown",
    );
    expect(
      conversationSpaceNote({ id: "slack:T1:D1", type: "direct", visibility: "private" }),
    ).toContain("This conversation is a direct conversation with one person.");
  });

  it("adds nothing when the channel reports no space", async () => {
    expect((await systemParts()).join("\n")).not.toContain("<conversation_space>");
  });
});

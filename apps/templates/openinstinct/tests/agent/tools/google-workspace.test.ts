import { describe, expect, it, vi } from "vitest";
import type * as GmailModule from "@agent/lib/google-workspace/gmail";
import type { updateGmail } from "@agent/lib/google-workspace/gmail";
import { toolContextFor } from "@tests/helpers/tool-context";

const gmail = vi.hoisted(() => ({
  update: vi
    .fn<typeof updateGmail>()
    .mockResolvedValue({ action: "archive", updatedCount: 2 }),
}));

vi.mock("@agent/lib/google-workspace/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailModule>()),
  updateGmail: gmail.update,
}));

import { gmailUpdate } from "@agent/tools/gmail";

describe("Google Workspace tools", () => {
  it("reports the selected Gmail update without an action discriminator", async () => {
    const context = toolContext();
    const result = await gmailUpdate.execute(
      { messageIds: ["message-1", "message-2"], update: "archive" },
      context
    );

    expect(gmail.update).toHaveBeenCalledExactlyOnceWith(
      context,
      ["message-1", "message-2"],
      "archive"
    );
    expect(result).toEqual({ update: "archive", updatedCount: 2 });
  });
});

function toolContext() {
  return toolContextFor({
    callId: "call-1",
    sessionId: "session-1",
    toolName: "gmail-update",
  });
}

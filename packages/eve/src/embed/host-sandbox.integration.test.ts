import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { eve } from "#definitions/defaults.js";
import { codeAgent } from "#embed/agent.js";
import { createSession } from "#embed/session.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { hostSandbox } from "#runtime/sandbox/host-sandbox.js";
import { always } from "#tools/approval/policies.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "eve-host-root-")));
const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "eve-host-elsewhere-")));
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(elsewhere, { force: true, recursive: true });
});

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

/**
 * Calls `toolName` with what follows `<prefix>: ` in the user's message as its `field`, then
 * replies with the call's result.
 */
function relay(toolName: string, field: string, prefix: string) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const last = prompt.at(-1);
        if (last?.role === "tool") {
          const part = last.content.find((entry) => entry.type === "tool-result");
          return textStreamResult(
            JSON.stringify(part?.type === "tool-result" ? part.output : null),
          );
        }
        const text =
          last?.role === "user" ? last.content.find((entry) => entry.type === "text") : undefined;
        const value = text?.type === "text" ? text.text.replace(`${prefix}: `, "") : "";
        return toolCallsStreamResult([
          {
            input: JSON.stringify({ [field]: value }),
            toolCallId: `${toolName}-${prompt.length}`,
            toolName,
          },
        ]);
      },
      modelId: `host-${toolName}`,
      provider: "eve-test",
    }),
  );
}

describe("a code agent on the host directory", () => {
  it("keeps the file tools inside the root when confined", async () => {
    await writeFile(join(root, "inside.txt"), "in the root");
    await writeFile(join(elsewhere, "outside.txt"), "in another tree");
    const session = createSession(
      codeAgent({
        definitions: eve.defaults({
          sandbox: hostSandbox({ confine: true, root: () => root }),
          without: ["web_search", "web_fetch"],
        }),
        model: {
          model: relay("read_file", "filePath", "READ"),
          modelContextWindowTokens: 200_000,
        },
        name: "host-confined",
      }),
      { identity: alice },
    );
    try {
      const inside = await (await session.send("READ: inside.txt")).result();
      expect(inside.reply).toContain("in the root");
      const outside = await (
        await session.send(`READ: ${join(elsewhere, "outside.txt")}`)
      ).result();
      expect(outside.reply).toContain("is outside the sandbox's root");
      expect(outside.reply).not.toContain("in another tree");
      const upward = await (await session.send("READ: ../outside.txt")).result();
      expect(upward.reply).toContain("is outside the sandbox's root");
    } finally {
      await session.close();
    }
  });

  it("runs approved bash in the directory the host is in", async () => {
    const session = createSession(
      codeAgent({
        definitions: eve.defaults({
          approval: { bash: always() },
          sandbox: hostSandbox({ root: () => root }),
          without: ["web_search", "web_fetch"],
        }),
        model: { model: relay("bash", "command", "RUN"), modelContextWindowTokens: 200_000 },
        name: "host-coder",
      }),
      { identity: alice },
    );
    try {
      const asked = await (await session.send("RUN: pwd && touch made-here.txt")).result();
      expect(asked.interactions.map((interaction) => interaction.call?.name)).toEqual(["bash"]);
      expect(existsSync(join(root, "made-here.txt"))).toBe(false);
      const answered = await (
        await session.respond([
          { interactionId: asked.interactions[0]!.interactionId, optionId: "approve" },
        ])
      ).result();
      expect(answered.reply).toContain(root);
      expect(existsSync(join(root, "made-here.txt"))).toBe(true);
    } finally {
      await session.close();
    }
  });
});

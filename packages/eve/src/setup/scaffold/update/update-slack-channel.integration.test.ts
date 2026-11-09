import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureChannel } from "./channels.js";
import { readSlackChannelFile } from "./update-slack-channel.js";

describe("readSlackChannelFile", () => {
  it("recognizes the channel files eve scaffolds", async () => {
    const connect = await mkdtemp(join(tmpdir(), "eve-slack-file-"));
    const environment = await mkdtemp(join(tmpdir(), "eve-slack-file-"));
    await ensureChannel({
      projectRoot: connect,
      kind: "slack",
      slackConnectorUid: "slack/chief",
      skipDependencyMutation: true,
    });
    await ensureChannel({
      projectRoot: environment,
      kind: "slack",
      slackCredentials: "environment",
      skipDependencyMutation: true,
    });

    await expect(readSlackChannelFile(join(connect, "agent/channels/slack.ts"))).resolves.toEqual({
      kind: "connect",
      connectorUid: "slack/chief",
    });
    await expect(
      readSlackChannelFile(join(environment, "agent/channels/slack.ts")),
    ).resolves.toEqual({ kind: "environment" });
    await expect(readSlackChannelFile(join(connect, "missing.ts"))).resolves.toEqual({
      kind: "absent",
    });
  });

  it("treats hand-written credential wiring as custom", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-slack-file-"));
    const path = join(root, "slack.ts");
    await writeFile(
      path,
      `const uid = process.env.VERCEL_ENV === "preview" ? "slack/a" : "slack/b";
export default slackChannel({ credentials: connectSlackCredentials(uid) });
`,
    );

    await expect(readSlackChannelFile(path)).resolves.toEqual({ kind: "custom" });
  });
});

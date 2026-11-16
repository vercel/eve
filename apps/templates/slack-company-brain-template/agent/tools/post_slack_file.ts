import { basename } from "node:path";
import { isChannel } from "eve/channels";
import { defineTool } from "eve/tools";
import { z } from "zod";
import slack from "../channels/slack.ts";
import { callSlack, slackTeamId } from "../lib/slack.ts";

// Bounds how much of a sandbox file one call holds in memory. Slack itself
// accepts much larger files.
const MAX_BYTES = 50 * 1024 * 1024;

const failed = (message: string) => ({ posted: false, message });

async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, size);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

// Uploads a sandbox file into the Slack conversation the session belongs to.
// The destination comes from the session's Slack channel metadata, never from
// the model. Uses Slack's external upload flow and needs the `files:write` scope.
export default defineTool({
  label: { start: () => "Posting a file to Slack", complete: () => "Posted a file to Slack" },
  description:
    "Post a file from your sandbox, such as a chart, CSV, report, or screenshot, into the current Slack thread. " +
    "Files you create are not shared automatically: call this once for each file the person should see, and skip files you made only for your own work. " +
    "The file posts on its own, before your reply, so don't paste its contents into the reply. Files up to 50 MB. Only works in Slack conversations.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Absolute sandbox path of the file, such as /workspace/report.csv."),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Title Slack shows on the file. Defaults to the file name."),
    altText: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("For an image, a short description for screen readers."),
  }),
  async execute({ path, title, altText }, ctx) {
    if (!isChannel(ctx.channel, slack)) {
      return failed(
        "Files can only be posted in Slack conversations. Give the sandbox path instead.",
      );
    }
    const { channelId, threadTs } = ctx.channel.metadata;
    const teamId = slackTeamId(ctx.session.auth.current) ?? ctx.channel.metadata.teamId;
    if (!channelId || !teamId) {
      return failed("This session has no Slack conversation to post in.");
    }

    const sandbox = await ctx.getSandbox();
    const stream = await sandbox.readFile({ path });
    if (!stream) return failed(`No file exists at ${path}.`);
    const bytes = await readAtMost(stream, MAX_BYTES);
    if (!bytes)
      return failed("The file is larger than 50 MB. Compress or split it, then try again.");
    if (bytes.byteLength === 0) return failed("The file is empty.");

    const filename = basename(path);
    const upload = await callSlack<{ upload_url: string; file_id: string }>(
      teamId,
      "files.getUploadURLExternal",
      { filename, length: bytes.byteLength, ...(altText ? { alt_txt: altText } : {}) },
    );
    if (!upload.ok || !upload.upload_url || !upload.file_id) {
      if (upload.error === "missing_scope") {
        return failed(
          "The Slack app is missing the `files:write` scope. An admin needs to add it and reinstall the app.",
        );
      }
      throw new Error(
        `Slack files.getUploadURLExternal failed: ${upload.error ?? "unknown error"}`,
      );
    }

    const sent = await fetch(upload.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      signal: ctx.abortSignal,
    });
    if (!sent.ok) throw new Error(`Slack file upload failed with HTTP ${sent.status}`);

    const completed = await callSlack(teamId, "files.completeUploadExternal", {
      files: JSON.stringify([{ id: upload.file_id, title: title ?? filename }]),
      channel_id: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    if (!completed.ok) {
      throw new Error(
        `Slack files.completeUploadExternal failed: ${completed.error ?? "unknown error"}`,
      );
    }
    return { posted: true, filename };
  },
});

---
title: "Voice Notes"
description: "Transcribe voice notes, voice messages, and other audio attachments with an AI Gateway transcription model so an eve agent can answer them."
---

Voice notes and other audio files reach your agent as files in its sandbox, but the model does not transcribe them. To let your agent answer a voice note, add a tool that transcribes the file.

This works for any channel that delivers audio as a file. Examples are iMessage voice notes through [Photon](../channels/photon), [Slack](../channels/slack#attachments) voice clips, and files sent through the [eve](../channels/eve) and [Chat SDK](../channels/chat-sdk#attachments) channels. See [Inbound attachments](../sandbox#inbound-attachments) for where eve saves these files.

## Add a transcription tool

```ts title="agent/tools/transcribe_audio.ts"
import { posix } from "node:path";
import { transcribe } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

const TRANSCRIPTION_MODEL = "openai/whisper-1";
const ATTACHMENTS_DIR = "/workspace/.eve/attachments/";

export default defineTool({
  description:
    "Transcribe an audio attachment, such as a voice note, to text. Pass the path from its `Attached file` label.",
  inputSchema: z.object({
    path: z.string().describe(`Attachment path under ${ATTACHMENTS_DIR}`),
  }),
  outputSchema: z.object({ transcript: z.string() }),
  async execute({ path }, ctx) {
    const file = posix.normalize(path);
    if (!file.startsWith(ATTACHMENTS_DIR)) {
      throw new Error(`Only attachments under ${ATTACHMENTS_DIR} can be transcribed.`);
    }

    const sandbox = await ctx.getSandbox();
    const audio = await sandbox.readBinaryFile({ path: file, signal: ctx.abortSignal });
    if (!audio) {
      throw new Error(`Attachment not found: ${file}. Ask the user to send the voice note again.`);
    }

    try {
      const { text } = await transcribe({
        model: TRANSCRIPTION_MODEL,
        audio,
        abortSignal: ctx.abortSignal,
      });
      return { transcript: text.trim() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Transcription failed (${reason}). Tell the user you couldn't understand the voice note and ask them to type it.`,
      );
    }
  },
});
```

`transcribe()` uses the same credentials as your eve agent.

## Tell the agent when to transcribe

```md title="agent/instructions.md"
When a message has an audio attachment (`Attached file ... (audio/...)`), such as a voice note, call `transcribe_audio` with its path first and treat the transcript as what the user said. Do not mention the transcription step unless it fails.
```

## When transcription fails

When `execute` throws, the model receives the error as a tool error and can relay it to the user. See [When a tool throws](../tools#when-a-tool-throws). A file eve can't download reaches the agent as a short note instead of a file. So does a file over the channel's upload limit, which is 25 MB by default.

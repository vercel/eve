---
title: "Voice Notes"
description: "Transcribe voice notes, voice messages, and other audio attachments so an eve agent can answer them."
---

Voice notes and other audio files reach your agent, but the model does not hear them. eve stages each inbound audio file in the sandbox and gives the model only a label with its path, such as `Attached file /workspace/.eve/attachments/<hash>/voice-note.m4a (audio/mp4)`. To let the agent answer a voice note, add a tool that transcribes the staged file to text.

The tool works for every channel that delivers audio as a file, including Slack voice clips, iMessage voice messages through [Photon](../channels/photon), and audio uploaded in [eve Web Chat](../channels/eve). See [Inbound attachments](../sandbox#inbound-attachments) for how eve stages files and which formats the model reads directly.

## Add a transcription tool

Install the AI SDK in your agent project:

```bash
npm install ai
```

Then add a tool that reads the staged file and transcribes it:

```ts title="agent/tools/transcribe_audio.ts"
import { transcribe } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

const TRANSCRIPTION_MODEL = "openai/gpt-4o-mini-transcribe";
const ATTACHMENTS_DIR = "/workspace/.eve/attachments/";

export default defineTool({
  description:
    "Transcribe an audio attachment, such as a voice note, to text. Pass the path from its `Attached file` label.",
  inputSchema: z.object({
    path: z.string().describe(`Attachment path under ${ATTACHMENTS_DIR}`),
  }),
  outputSchema: z.object({ transcript: z.string() }),
  async execute({ path }, ctx) {
    if (!path.startsWith(ATTACHMENTS_DIR)) {
      throw new Error(`Only attachments under ${ATTACHMENTS_DIR} can be transcribed.`);
    }

    const sandbox = await ctx.getSandbox();
    const audio = await sandbox.readBinaryFile({ path, abortSignal: ctx.abortSignal });
    if (!audio) {
      throw new Error(`Attachment not found: ${path}. Ask the user to send the voice note again.`);
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

The tool runs in your app runtime, reads the attachment bytes through `ctx.getSandbox()`, and passes them to the AI SDK `transcribe()` function. The path check keeps the tool scoped to staged attachments.

A string model ID routes through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and uses the same credentials as a string agent model: Vercel project OIDC on Vercel, or `AI_GATEWAY_API_KEY` on another host. See [Set the model](../agent-config#set-the-model).

## Tell the agent when to transcribe

The model decides when to call the tool, so say when it applies in your instructions:

```md title="agent/instructions.md"
When a message has an audio attachment (`Attached file ... (audio/...)`), such as a voice note, call `transcribe_audio` with its path first and treat the transcript as what the user said. Do not mention the transcription step unless it fails.
```

## Choose a transcription model

Set `TRANSCRIPTION_MODEL` to any AI Gateway transcription model, such as `openai/gpt-4o-mini-transcribe` or `openai/whisper-1`. Transcription is billed separately from the agent's chat model; see [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing).

Transcription models accept different audio formats. Send a sample from each channel you support, such as a Slack voice clip or an iMessage voice message, and confirm the model you choose transcribes it.

## Handle failed transcriptions

When `execute` throws, eve gives the error to the model as a tool error. The error messages above tell the model what to say: ask the user to resend a missing file, or to type the message when transcription fails. See [When a tool throws](../tools#when-a-tool-throws).

Transcription runs as a tool call, so the model sees the attachment label first and then calls the tool. Each voice note adds one tool call to the turn.

## What to read next

- How eve stores files and shows them to the model → [Inbound attachments](../sandbox#inbound-attachments)
- Tool authoring and the `ctx` parameter → [Tools](../tools)
- Slack attachment behavior → [Slack attachments](../channels/slack#attachments)

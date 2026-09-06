import { experimental_transcribe as transcribe, type TranscriptionModel } from "ai";

/** Options for {@link transcribeAudio}. */
export interface TranscribeAudioOptions {
  /** Gateway transcription model, e.g. from `transcriptionModel("openai/whisper-1")`. */
  readonly model: TranscriptionModel;
  /** Raw bytes of one spoken utterance (e.g. webm/opus captured in the browser). */
  readonly audio: Uint8Array;
  /** Aborts an in-flight transcription, e.g. when the peer disconnects. */
  readonly abortSignal?: AbortSignal;
}

/** Transcript of one spoken utterance. */
export interface TranscribeAudioResult {
  readonly text: string;
  readonly language: string | undefined;
  readonly durationInSeconds: number | undefined;
}

/**
 * Transcribes one audio utterance to text through the AI Gateway.
 *
 * Transcription is batch, not streaming: the whole utterance is sent and the
 * complete transcript returned, so callers must decide where an utterance ends
 * (the voice channel relies on the client to send one utterance per message).
 */
export async function transcribeAudio(
  options: TranscribeAudioOptions,
): Promise<TranscribeAudioResult> {
  const result = await transcribe({
    model: options.model,
    audio: options.audio,
    abortSignal: options.abortSignal,
  });

  return {
    text: result.text,
    language: result.language,
    durationInSeconds: result.durationInSeconds,
  };
}

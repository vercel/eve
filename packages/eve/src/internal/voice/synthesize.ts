import { experimental_generateSpeech as generateSpeech, type SpeechModel } from "ai";

/** Options for {@link synthesizeSpeech}. */
export interface SynthesizeSpeechOptions {
  /** Gateway speech model, e.g. from `speechModel("openai/tts-1")`. */
  readonly model: SpeechModel;
  /** Text to speak — typically one sentence produced by the agent. */
  readonly text: string;
  /** Provider voice, e.g. `"alloy"`. Defaults to the model's default voice. */
  readonly voice?: string;
  /** Audio container, e.g. `"mp3"` or `"wav"`. Defaults to the model's default. */
  readonly outputFormat?: string;
  /** Free-form delivery guidance, e.g. `"Speak calmly"`. */
  readonly instructions?: string;
  /** Playback speed multiplier. */
  readonly speed?: number;
  /** Aborts an in-flight synthesis, e.g. on barge-in. */
  readonly abortSignal?: AbortSignal;
}

/** Synthesized speech audio for a chunk of text. */
export interface SynthesizeSpeechResult {
  /** Encoded audio bytes in {@link SynthesizeSpeechResult.format}. */
  readonly audio: Uint8Array;
  /** Audio container/codec of {@link SynthesizeSpeechResult.audio}, e.g. `"mp3"`. */
  readonly format: string;
}

/**
 * Synthesizes speech audio from text through the AI Gateway.
 *
 * Synthesis is batch, not streaming: the whole text is converted and the
 * complete audio returned. The voice channel calls this once per sentence so
 * the first sentence can play while later ones are still being generated.
 */
export async function synthesizeSpeech(
  options: SynthesizeSpeechOptions,
): Promise<SynthesizeSpeechResult> {
  const result = await generateSpeech({
    model: options.model,
    text: options.text,
    voice: options.voice,
    outputFormat: options.outputFormat,
    instructions: options.instructions,
    speed: options.speed,
    abortSignal: options.abortSignal,
  });

  return { audio: result.audio.uint8Array, format: result.audio.format };
}

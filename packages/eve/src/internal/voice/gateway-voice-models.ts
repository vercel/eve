import { gateway, type SpeechModel, type TranscriptionModel } from "ai";

/**
 * Resolves a Gateway transcription (speech-to-text) model by id, e.g.
 * `"openai/whisper-1"`.
 *
 * The AI Gateway provider resolves credentials the same way eve's language
 * models do — an `AI_GATEWAY_API_KEY` when present, otherwise a Vercel OIDC
 * token — so a voice channel needs no separate credential wiring.
 */
export function transcriptionModel(modelId: string): TranscriptionModel {
  return gateway.transcriptionModel(modelId);
}

/**
 * Resolves a Gateway speech (text-to-speech) model by id, e.g. `"openai/tts-1"`.
 * See {@link transcriptionModel} for how credentials are resolved.
 */
export function speechModel(modelId: string): SpeechModel {
  return gateway.speechModel(modelId);
}

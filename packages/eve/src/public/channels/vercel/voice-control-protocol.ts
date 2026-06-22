/**
 * Eve's vocabulary for the AI Gateway speech-engine control protocol. The wire
 * contract (envelope, events, capabilities, codec) is defined once in
 * `@ai-sdk/gateway` and shared with the Gateway so the two can't drift; this
 * module just re-exports it under Eve-local names. Eve is the controller: it
 * receives engine→controller events and sends controller→engine events.
 */
export {
  DEFAULT_SPEECH_ENGINE_CAPABILITIES as DEFAULT_CONTROL_CAPABILITIES,
  encodeSpeechEngineEvent as encodeControlPacket,
  GATEWAY_SPEECH_ENGINE_SUBPROTOCOL as EVE_VOICE_CONTROL_PROTOCOL,
  parseSpeechEngineServerEvent as parseControlPacket,
  type SpeechEngineCapabilities as RealtimeControlCapabilities,
  type SpeechEngineClientEvent as EveToGatewayEvent,
  type SpeechEngineDescriptor as RealtimeControlEngine,
  type SpeechEngineServerEvent as GatewayToEveEvent,
} from "@ai-sdk/gateway";

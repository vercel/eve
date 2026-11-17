import {
  emptyTwilioResponse,
  escapeXml,
  gatherSpeechTwilioResponse,
  sayTwilioResponse,
  twilioResponse,
  type TwilioGatherSpeechResponseOptions,
} from "#compiled/@chat-adapter/twilio/voice.js";

/** Options for rendering a Twilio `<Gather input="speech">` TwiML response. */
export type TwilioGatherTwimlOptions = TwilioGatherSpeechResponseOptions;

export { emptyTwilioResponse, escapeXml, gatherSpeechTwilioResponse, sayTwilioResponse };

export function twimlResponse(twiml: string): Response {
  return twilioResponse(twiml);
}

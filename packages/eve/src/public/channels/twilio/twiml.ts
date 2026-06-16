/**
 * Tiny TwiML builders for Twilio webhook responses.
 *
 * The channel keeps TwiML generation local so callers do not need the
 * Twilio SDK just to acknowledge a webhook or gather speech.
 */

/** Options for rendering a voice `<Gather input="speech">` response. */
export interface TwilioGatherTwimlOptions {
  /** Absolute callback URL that receives the speech result. */
  readonly actionUrl: string;
  /** Prompt spoken before Twilio starts speech recognition. */
  readonly prompt: string;
  /** Twilio `<Say voice>` used for the prompt, e.g. `Polly.Joanna-Neural`. */
  readonly voice?: string;
  /** BCP 47 language used for speech recognition and the nested `<Say>` prompt. */
  readonly language?: string;
  /** Twilio `<Gather speechModel>` used for speech recognition. */
  readonly speechModel?: string;
  /** Twilio `<Gather timeout>` in seconds. */
  readonly timeoutSeconds?: number;
  /** Twilio `<Gather speechTimeout>`, such as `"auto"` or a second count string. */
  readonly speechTimeout?: string;
  /** Twilio `<Gather hints>` for expected words or phrases. */
  readonly hints?: string | readonly string[];
  /** Twilio `<Gather profanityFilter>` toggle. */
  readonly profanityFilter?: boolean;
}

/** Returns an empty TwiML response, useful for acknowledging inbound SMS without replying. */
export function emptyTwilioResponse(): Response {
  return twimlResponse("<Response></Response>");
}

/** Returns a TwiML response that speaks `message` and then ends the call. */
export function sayTwilioResponse(message: string): Response {
  return twimlResponse(`<Response><Say>${escapeXml(message)}</Say></Response>`);
}

/** Returns a TwiML response that asks the caller to speak and posts the transcript to `actionUrl`. */
export function gatherSpeechTwilioResponse(options: TwilioGatherTwimlOptions): Response {
  const hints = typeof options.hints === "string" ? options.hints : options.hints?.join(",");
  const attributes = [
    `input="speech"`,
    `action="${escapeXml(options.actionUrl)}"`,
    `method="POST"`,
    `actionOnEmptyResult="true"`,
    options.language ? `language="${escapeXml(options.language)}"` : undefined,
    options.speechModel ? `speechModel="${escapeXml(options.speechModel)}"` : undefined,
    options.timeoutSeconds !== undefined ? `timeout="${options.timeoutSeconds}"` : undefined,
    options.speechTimeout ? `speechTimeout="${escapeXml(options.speechTimeout)}"` : undefined,
    hints ? `hints="${escapeXml(hints)}"` : undefined,
    options.profanityFilter !== undefined
      ? `profanityFilter="${options.profanityFilter ? "true" : "false"}"`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const sayAttributes = [
    options.voice ? `voice="${escapeXml(options.voice)}"` : undefined,
    options.language ? `language="${escapeXml(options.language)}"` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  const sayOpen = sayAttributes ? `<Say ${sayAttributes}>` : "<Say>";

  return twimlResponse(
    `<Response><Gather ${attributes}>${sayOpen}${escapeXml(options.prompt)}</Say></Gather></Response>`,
  );
}

/** Wraps a TwiML string in a Twilio-compatible XML response. */
export function twimlResponse(twiml: string): Response {
  return new Response(twiml, {
    status: 200,
    headers: { "content-type": "text/xml;charset=UTF-8" },
  });
}

/** Escapes the five XML predefined entities (`&`, `<`, `>`, `"`, `'`) for safe use in TwiML element content or attribute values. Note that `'` becomes `&apos;`. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

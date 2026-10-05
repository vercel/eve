import { twilioChannel } from "#public/channels/twilio/index.js";
import { signTwilioRequest } from "#public/channels/twilio/verify.js";
import {
  type ChannelDriver,
  type PlatformCall,
  numberedOptions,
  recordingFetch,
  type SentFile,
  serveFile,
} from "#internal/testing/channel-conformance/harness.js";

const ACCOUNT_SID = "AC123";
const AUTH_TOKEN = "twilio-conformance-secret";
const TO = "+15550000001";
let nextPerson = 0;

/** Drives SMS webhooks and Twilio's form-encoded Messages API. */
export function twilioDriver(): ChannelDriver {
  nextPerson += 1;
  const PERSON = `+1555000${String(nextPerson).padStart(4, "0")}`;
  let messageSid = 0;
  /** Files a person sent, by the media URL the webhook listed each under. */
  const uploads = new Map<string, SentFile>();
  const webhookUrl = "https://agent.example.com/eve/v1/twilio/messages";

  function message(text: string, files: readonly SentFile[] = []): Request {
    messageSid += 1;
    // An MMS lists its media by URL, numbered from zero.
    const media = files.flatMap((file, index) => {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/MM${messageSid}/Media/ME${index}`;
      uploads.set(url, file);
      return [
        [`MediaContentType${index}`, file.mediaType],
        [`MediaUrl${index}`, url],
      ];
    });
    const params = new URLSearchParams({
      Body: text,
      From: PERSON,
      MessageSid: `SM-conformance-${messageSid}`,
      NumMedia: String(files.length),
      To: TO,
      ...Object.fromEntries(media),
    });
    return new Request(webhookUrl, {
      body: params,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signTwilioRequest({ authToken: AUTH_TOKEN, params, url: webhookUrl }),
      },
      method: "POST",
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.includes("/Media/")) {
      // Twilio serves media to the account's Basic auth.
      const authorized =
        request.headers.get("authorization") === `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`;
      return {
        body: {},
        method: `GET ${url.pathname}`,
        response: authorized
          ? serveFile(uploads.get(url.href))
          : new Response("Unauthorized", { status: 401 }),
      };
    }
    return {
      body: Object.fromEntries(new URLSearchParams(await request.text())),
      method: url.pathname.split("/").at(-1) ?? "",
      response: { sid: "SM-conformance-response" },
    };
  }

  return {
    name: "twilio",
    capabilities: ["attachments", "text-replies"],
    surface: "private",
    createChannel: (record) =>
      twilioChannel({
        allowFrom: "*",
        credentials: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN },
        api: { fetch: recordingFetch(record, decode) },
        messaging: { from: TO },
      }),
    message: (text, _person, files) => message(text, files),
    findOptions(call, prompt) {
      if (call.method !== "Messages.json") return undefined;
      const body = call.body as { readonly Body?: unknown };
      if (typeof body.Body !== "string" || !body.Body.includes(prompt)) return undefined;
      return numberedOptions(body.Body);
    },
    press: () => {
      throw new Error("Twilio SMS does not support pressing options.");
    },
    postedText(call) {
      if (call.method !== "Messages.json") return undefined;
      const body = call.body as { readonly Body?: unknown };
      return typeof body.Body === "string" ? body.Body : undefined;
    },
  };
}

import { twilioChannel } from "#public/channels/twilio/index.js";
import { signTwilioRequest } from "#public/channels/twilio/verify.js";
import {
  type ChannelDriver,
  type PlatformCall,
  numberedOptions,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

const AUTH_TOKEN = "twilio-conformance-secret";
const TO = "+15550000001";
let nextPerson = 0;

/** Drives SMS webhooks and Twilio's form-encoded Messages API. */
export function twilioDriver(): ChannelDriver {
  nextPerson += 1;
  const PERSON = `+1555000${String(nextPerson).padStart(4, "0")}`;
  let messageSid = 0;
  const webhookUrl = "https://agent.example.com/eve/v1/twilio/messages";

  function message(text: string): Request {
    messageSid += 1;
    const params = new URLSearchParams({
      Body: text,
      From: PERSON,
      MessageSid: `SM-conformance-${messageSid}`,
      To: TO,
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
    return {
      body: Object.fromEntries(new URLSearchParams(await request.text())),
      method: url.pathname.split("/").at(-1) ?? "",
      response: { sid: "SM-conformance-response" },
    };
  }

  return {
    name: "twilio",
    capabilities: ["text-replies"],
    surface: "private",
    createChannel: (record) =>
      twilioChannel({
        allowFrom: "*",
        credentials: { accountSid: "AC123", authToken: AUTH_TOKEN },
        api: { fetch: recordingFetch(record, decode) },
        messaging: { from: TO },
      }),
    message,
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

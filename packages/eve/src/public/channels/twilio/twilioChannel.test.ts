import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { twilioChannel, type TwilioChannelConfig } from "#public/channels/twilio/index.js";
import { signTwilioRequest } from "#public/channels/twilio/verify.js";

const AUTH_TOKEN = "twilio-test-secret";
const ALICE = "+15550000001";
const BOB = "+15550000002";
const AGENT = "+15550000100";

function channel(config: Partial<TwilioChannelConfig> = {}) {
  return twilioChannel({
    allowFrom: [ALICE],
    credentials: { accountSid: "AC123", authToken: AUTH_TOKEN },
    messaging: { from: AGENT },
    ...config,
  });
}

function signed(path: string, fields: Record<string, string>): Request {
  const url = `https://agent.example.com/eve/v1/twilio/${path}`;
  const params = new URLSearchParams(fields);
  return new Request(url, {
    body: params,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signTwilioRequest({ authToken: AUTH_TOKEN, params, url }),
    },
    method: "POST",
  });
}

const sms = (from: string) =>
  signed("messages", { Body: "Hello", From: from, MessageSid: "SM1", NumMedia: "0", To: AGENT });
const call = (from: string) =>
  signed("voice", { AccountSid: "AC123", CallSid: "CA1", From: from, To: AGENT });

async function post(compiled: unknown, request: Request) {
  if (!isCompiledChannel(compiled)) throw new Error("Expected a compiled channel.");
  const pathname = new URL(request.url).pathname;
  const route = compiled.routes.find(
    (candidate) => candidate.method === "POST" && candidate.path === pathname,
  );
  if (!route || !isHttpRouteDefinition(route)) throw new Error(`No POST route for ${pathname}.`);
  const send = vi.fn();
  const waitUntil = vi.fn();
  const response = await route.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as never,
    ...mockChannelContext(send),
    to: vi.fn() as never,
    params: {},
    requestIp: null,
    waitUntil,
  });
  return { response, waitUntil };
}

describe("twilioChannel allowFrom", () => {
  it("rejects a text from a number outside allowFrom before dispatching", async () => {
    const { response, waitUntil } = await post(channel(), sms(BOB));

    expect(response.status).toBe(403);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a call from a number outside allowFrom before running onVoice", async () => {
    const onVoice = vi.fn();
    const { response } = await post(channel({ onVoice }), call(BOB));

    expect(response.status).toBe(403);
    expect(onVoice).not.toHaveBeenCalled();
  });
});

describe("twilioChannel voice", () => {
  it("answers an allowed call with an escaped speech Gather posting to the transcription route", async () => {
    const { response } = await post(
      channel({ voice: { prompt: 'Say "yes" & <wait>' } }),
      call(ALICE),
    );
    const twiml = await response.text();

    expect(response.status).toBe(200);
    expect(twiml).toContain('<Gather input="speech"');
    expect(twiml).toContain('action="https://agent.example.com/eve/v1/twilio/voice/transcription"');
    expect(twiml).toContain("Say &quot;yes&quot; &amp; &lt;wait&gt;");
    expect(twiml).not.toContain("<wait>");
  });
});

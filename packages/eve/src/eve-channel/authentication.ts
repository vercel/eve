import type {
  ChannelAuthenticationCallbackInput,
  ChannelAuthenticationResolution,
} from "#channel/authentication.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  isAuthInteractionRequired,
  type AuthFn,
  type AuthInteractionMatch,
} from "#public/channels/auth.js";

interface EveSenderAuthenticationEvent {
  readonly request: {
    readonly method: string;
    readonly url: string;
  };
  readonly strategyIndex: number;
}

function authStrategies(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
): readonly AuthFn<Request>[] {
  return Array.isArray(auth) ? auth : [auth as AuthFn<Request>];
}

function readSenderAuthenticationEvent(value: unknown): EveSenderAuthenticationEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("request" in value) ||
    typeof value.request !== "object" ||
    value.request === null ||
    !("method" in value.request) ||
    typeof value.request.method !== "string" ||
    !("url" in value.request) ||
    typeof value.request.url !== "string" ||
    !("strategyIndex" in value) ||
    typeof value.strategyIndex !== "number" ||
    !Number.isSafeInteger(value.strategyIndex) ||
    value.strategyIndex < 0
  ) {
    throw new Error("Invalid eve sender-auth event.");
  }
  return value as EveSenderAuthenticationEvent;
}

function rebuildSenderAuthenticationRequest(event: EveSenderAuthenticationEvent): Request {
  return new Request(event.request.url, { method: event.request.method });
}

export function createEveSenderAuthenticationEvent(
  request: Request,
  interaction: AuthInteractionMatch,
): EveSenderAuthenticationEvent {
  const url = new URL(request.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return {
    request: { method: request.method, url: url.toString() },
    strategyIndex: interaction.strategyIndex,
  };
}

export async function authenticateEveSender(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
  event: unknown,
  callbackUrl: string,
): Promise<ChannelAuthenticationResolution> {
  const parsed = readSenderAuthenticationEvent(event);
  const strategy = authStrategies(auth)[parsed.strategyIndex];
  if (strategy === undefined) {
    throw new Error("eve sender authentication strategy changed while sign-in was pending.");
  }
  const result = await strategy(rebuildSenderAuthenticationRequest(parsed));
  if (result === null || result === undefined) return { kind: "not-authenticated" };
  if (!isAuthInteractionRequired(result)) {
    return { auth: result, kind: "authenticated" };
  }
  const started = await result.startAuthorization({ callbackUrl });
  return {
    challenge: started.challenge,
    kind: "interaction-required",
    resume: started.resume,
    strategyIndex: parsed.strategyIndex,
  };
}

export async function completeEveSenderAuthentication(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
  callback: ChannelAuthenticationCallbackInput,
): Promise<SessionAuthContext> {
  const parsed = readSenderAuthenticationEvent(callback.event);
  if (parsed.strategyIndex !== callback.strategyIndex) {
    throw new Error("eve sender authentication strategy changed while sign-in was pending.");
  }
  const strategy = authStrategies(auth)[callback.strategyIndex];
  if (strategy === undefined) {
    throw new Error("eve sender authentication strategy changed while sign-in was pending.");
  }
  const result = await strategy(rebuildSenderAuthenticationRequest(parsed));
  if (!isAuthInteractionRequired(result)) {
    throw new Error("eve sender authentication strategy changed while sign-in was pending.");
  }
  return await result.completeAuthorization({
    callback: callback.callback,
    callbackUrl: callback.callbackUrl,
    resume: callback.resume,
  });
}

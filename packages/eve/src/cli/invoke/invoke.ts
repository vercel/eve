import {
  Client,
  ClientError,
  type ClientSession,
  type SessionStreamEvent,
  type ClientSessionState,
} from "#client/index.js";
import type { SendTurnPayload } from "#client/types.js";
import { collectTurnEvents, summarizeTurnEvents } from "#client/session-utils.js";
import { deliveryEvents } from "#client/delivery-events.js";
import { parseJsonValue } from "#shared/json.js";
import type { RemoteDevelopmentTarget } from "#services/dev-client/target.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";
import { resolveVerifiedRemoteDevelopmentClient } from "#setup/verified-remote-client.js";

import { type InvokeResult, type InvokeResume, projectInvocationInteraction } from "./result.js";

export type InvokeOperation =
  | { readonly kind: "send"; readonly payload: SendTurnPayload; readonly resume?: InvokeResume }
  | { readonly kind: "follow"; readonly resume: InvokeResume };

export interface RunInvokeInput {
  readonly headers?: Readonly<Record<string, string>>;
  readonly operation: InvokeOperation;
  readonly signal?: AbortSignal;
  readonly target: RemoteDevelopmentTarget;
  readonly vercelScope?: string;
}

/** Runs one non-interactive eve invocation. */
export async function runInvoke(input: RunInvokeInput): Promise<InvokeResult> {
  const { client, deploymentResolution } = await createInvokeClient(input);
  const resume = input.operation.resume;

  if (input.operation.kind === "follow") {
    const session = client.sessions.attach(resume!.session.sessionId, {
      streamIndex: resume!.session.streamIndex,
    });
    return observeSafely(
      input,
      session,
      deliveryEvents(session.stream({ signal: input.signal, startIndex: 0 }), resume!.deliveryId),
      resume!.deliveryId,
      deploymentResolution,
    );
  }

  let response: Awaited<ReturnType<ClientSession["send"]>>;
  let session: ClientSession;
  try {
    const payload = { ...input.operation.payload, signal: input.signal };
    if (resume === undefined) {
      if (payload.message === undefined) {
        throw new Error("Cannot answer an input request before the session starts.");
      }
      const created = await client.sessions.create({ ...payload, message: payload.message });
      session = created.session;
      response = created.response;
    } else {
      session = client.sessions.attach(resume.session.sessionId, {
        streamIndex: resume.session.streamIndex,
      });
      const { answers, message, ...options } = payload;
      response =
        answers === undefined
          ? await session.send(message!, options)
          : await session.respond(answers, options);
    }
  } catch (error) {
    const authentication = authenticationFailure(error, deploymentResolution);
    if (authentication !== undefined) throw authentication;
    throw error;
  }

  return observeSafely(input, session, response, response.deliveryId, deploymentResolution);
}

/** Converts a prompt and optional previous result into one valid invoke operation. */
export function resolveInvokeOperation(input: {
  readonly prompt?: string;
  readonly previous?: InvokeResult & { resume: InvokeResume };
}): InvokeOperation {
  const prompt = input.prompt?.trim();
  const previous = input.previous;
  if (previous === undefined) {
    if (!prompt)
      throw new Error("eve remote invoke requires a prompt unless --resume is provided.");
    return { kind: "send", payload: { message: prompt } };
  }

  if (previous.sessionEnded)
    throw new Error("This session has ended and cannot accept another message.");
  const signingIn =
    previous.status === "awaiting-input" &&
    previous.interactions.every((interaction) => interaction.request.kind === "sign-in");
  if (previous.status === "awaiting-input" && !signingIn) {
    if (!prompt) throw new Error("This invocation is waiting for an answer.");
    return { kind: "send", payload: { message: prompt }, resume: previous.resume };
  }
  if (signingIn || previous.status === "working") {
    if (prompt)
      throw new Error(
        signingIn
          ? "Complete the requested sign-in, then resume without a prompt."
          : "A working invocation cannot accept a follow-up prompt.",
      );
    return { kind: "follow", resume: previous.resume };
  }
  if (!prompt) throw new Error("A settled invocation requires a follow-up prompt.");
  return { kind: "send", payload: { message: prompt }, resume: previous.resume };
}

async function createInvokeClient(input: RunInvokeInput): Promise<{
  readonly client: Client;
  readonly deploymentResolution?: VercelDeploymentResolution;
}> {
  const { deploymentResolution, options } = await resolveVerifiedRemoteDevelopmentClient({
    headers: input.headers,
    serverUrl: input.target.serverUrl,
    signal: input.signal,
    vercelScope: input.vercelScope,
    workspaceRoot: input.target.workspaceRoot,
  });
  return {
    client: new Client(options),
    deploymentResolution,
  };
}

async function observeSafely(
  input: RunInvokeInput,
  session: ClientSession,
  response: AsyncIterable<SessionStreamEvent>,
  deliveryId: string,
  deploymentResolution?: VercelDeploymentResolution,
): Promise<InvokeResult> {
  try {
    return await observeInvocation(input.target, session, response, deliveryId);
  } catch (error) {
    if (input.signal?.aborted === true)
      return workingResult(input.target, session.state, deliveryId);
    const authentication = authenticationFailure(error, deploymentResolution);
    if (authentication !== undefined) throw authentication;
    throw error;
  }
}

async function observeInvocation(
  target: RemoteDevelopmentTarget,
  session: ClientSession,
  response: AsyncIterable<SessionStreamEvent>,
  deliveryId: string,
): Promise<InvokeResult> {
  const summary = summarizeTurnEvents(await collectTurnEvents(response, deliveryId), deliveryId);
  return {
    status: summary.status,
    sessionEnded: summary.sessionEnded,
    resume: createResume(target, session.state, deliveryId),
    interactions: summary.interactions.map(projectInvocationInteraction),
    reply: summary.message,
    data: summary.result === undefined ? undefined : parseJsonValue(summary.result),
    error: summary.failure,
  };
}

function workingResult(
  target: RemoteDevelopmentTarget,
  state: ClientSessionState,
  deliveryId: string,
): InvokeResult {
  return {
    status: "working",
    sessionEnded: false,
    interactions: [],
    resume: createResume(target, state, deliveryId),
  };
}

function createResume(
  target: RemoteDevelopmentTarget,
  session: ClientSessionState,
  deliveryId: string,
): InvokeResume {
  return { session, deliveryId, target: { kind: "remote", serverUrl: target.serverUrl } };
}

function authenticationFailure(
  error: unknown,
  deploymentResolution?: VercelDeploymentResolution,
): Error | undefined {
  let message: string | undefined;
  let code: string | undefined;
  if (deploymentResolution?.kind === "not-found") {
    message =
      "Vercel could not resolve this deployment in the selected scope. Retry with the owning team's slug via --scope <team-slug>, or provide an explicit Authorization header with -H.";
  } else if (isVercelAuthChallenge(error)) {
    message =
      "Vercel Deployment Protection rejected the available credentials. Configure Trusted Sources or set VERCEL_AUTOMATION_BYPASS_SECRET, then retry.";
  } else if (error instanceof ClientError) {
    code = vercelTrustedSourcesErrorCode(error.message);
    if (error.status === 403 && code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH") {
      message = formatVercelTrustedSourcesFailure(error.message);
    } else if (isEveAuthorizationError(error)) {
      message =
        "The deployment rejected the available credentials. Confirm its eve channel authorization and that your account can access the owning project.";
    }
  }
  if (message === undefined) return undefined;
  return new Error(code === undefined ? message : `${message} (${code})`);
}

function isEveAuthorizationError(error: ClientError): boolean {
  if (error.status !== 401) return false;
  try {
    const payload = JSON.parse(error.body) as Record<string, unknown>;
    return payload.ok === false && payload.code === "unauthorized";
  } catch {
    return false;
  }
}

import {
  Client,
  ClientError,
  type ClientSession,
  type MessageStreamEvent,
  type SendTurnPayload,
  type ClientSessionState,
} from "#client/index.js";
import { collectTurnEvents, summarizeTurnEvents } from "#client/session-utils.js";
import { resolveLocalDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { resolveLinkedDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import type { DevelopmentTarget } from "#services/dev-client/target.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";
import { resolveVerifiedRemoteDevelopmentClient } from "#setup/verified-remote-client.js";

import {
  type InvokeAuthenticationFailure,
  type InvokeResult,
  type InvokeResume,
  projectInvocationInputRequest,
} from "./result.js";

export type InvokeOperation =
  | { readonly kind: "send"; readonly payload: SendTurnPayload; readonly resume?: InvokeResume }
  | { readonly kind: "follow"; readonly resume: InvokeResume };

export interface RunInvokeInput {
  readonly headers?: Readonly<Record<string, string>>;
  readonly operation: InvokeOperation;
  readonly signal?: AbortSignal;
  readonly target: DevelopmentTarget;
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
      session.stream({ signal: input.signal }),
      deploymentResolution,
    );
  }

  let response: Awaited<ReturnType<ClientSession["send"]>>;
  let session: ClientSession;
  try {
    const payload = { ...input.operation.payload, signal: input.signal };
    if (resume === undefined) {
      const created = await client.sessions.create(payload);
      session = created.session;
      response = created.response;
    } else {
      session = client.sessions.attach(resume.session.sessionId, {
        streamIndex: resume.session.streamIndex,
      });
      response = await session.send(payload);
    }
  } catch (error) {
    const authentication = authenticationFailure(error, undefined, deploymentResolution);
    if (authentication !== undefined) return authentication;
    throw error;
  }

  return observeSafely(input, session, response, deploymentResolution);
}

/** Converts a prompt and optional previous result into one valid invoke operation. */
export function resolveInvokeOperation(input: {
  readonly prompt?: string;
  readonly previous?: InvokeResult & { resume: InvokeResume };
}): InvokeOperation {
  const prompt = input.prompt?.trim();
  const previous = input.previous;
  if (previous === undefined) {
    if (!prompt) throw new Error("eve invoke requires a prompt unless --resume is provided.");
    return { kind: "send", payload: { message: prompt } };
  }

  if (previous.status === "input-required") {
    if (!prompt) throw new Error("This invocation is waiting for an input response.");
    return { kind: "send", payload: { message: prompt }, resume: previous.resume };
  }

  if (
    previous.status === "running" ||
    previous.status === "authorization-required" ||
    previous.status === "authentication-required"
  ) {
    if (prompt) {
      throw new Error(
        previous.status === "running"
          ? "A running invocation cannot accept a follow-up prompt."
          : "Complete the requested authorization, then resume without a prompt.",
      );
    }
    return { kind: "follow", resume: previous.resume };
  }

  if (previous.status !== "ready") {
    throw new Error(`A terminal ${previous.status} invocation cannot be resumed.`);
  }
  if (!prompt) throw new Error("A ready invocation requires a follow-up prompt.");
  return { kind: "send", payload: { message: prompt }, resume: previous.resume };
}

async function createInvokeClient(input: RunInvokeInput): Promise<{
  readonly client: Client;
  readonly deploymentResolution?: VercelDeploymentResolution;
}> {
  if (input.target.kind === "local") {
    return {
      client: new Client({
        ...resolveLocalDevelopmentClientOptions({
          headers: input.headers,
          serverUrl: input.target.serverUrl,
          token: () => resolveLinkedDevelopmentOidcToken(input.target.workspaceRoot),
        }),
      }),
    };
  }

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
  response: AsyncIterable<MessageStreamEvent>,
  deploymentResolution?: VercelDeploymentResolution,
): Promise<InvokeResult> {
  try {
    return await observeInvocation(input.target, session, response);
  } catch (error) {
    if (input.signal?.aborted === true) return runningResult(input.target, session.state);
    const authentication = authenticationFailure(
      error,
      createResume(input.target, session.state),
      deploymentResolution,
    );
    if (authentication !== undefined) return authentication;
    throw error;
  }
}

async function observeInvocation(
  target: DevelopmentTarget,
  session: ClientSession,
  response: AsyncIterable<MessageStreamEvent>,
): Promise<InvokeResult> {
  const summary = summarizeTurnEvents(await collectTurnEvents(response));
  if (summary.boundary === undefined) return runningResult(target, session.state);
  if (summary.boundary.type === "session.failed") {
    return { status: "failed", message: summary.boundary.data.message };
  }

  const resume = createResume(target, session.state);
  if (summary.failure?.type === "turn.failed") {
    return {
      status: "ready",
      outcome: { status: "failed", message: summary.failure.data.message },
      resume,
    };
  }
  if (summary.inputRequests.length > 0) {
    return {
      status: "input-required",
      requests: summary.inputRequests.map(projectInvocationInputRequest),
      resume,
    };
  }

  const authorizations = summary.pendingAuthorizations;
  if (authorizations.length > 0) {
    if (
      target.kind === "local" &&
      authorizations.some((authorization) => authorization.webhookUrl !== undefined)
    ) {
      return {
        status: "failed",
        message:
          "Local eve invoke cannot pause for connection authorization because its temporary server must remain available for the callback. Run eve dev, then invoke its URL with --url.",
      };
    }
    return { status: "authorization-required", authorizations, resume };
  }

  const outcome =
    summary.message === undefined
      ? ({ status: "completed" } as const)
      : ({ status: "completed", message: summary.message } as const);
  return { status: "ready", outcome, resume };
}

function runningResult(target: DevelopmentTarget, state: ClientSessionState): InvokeResult {
  return { status: "running", resume: createResume(target, state) };
}

function createResume(target: DevelopmentTarget, session: ClientSessionState): InvokeResume {
  return {
    session,
    target:
      target.kind === "local" ? { kind: "local" } : { kind: "remote", serverUrl: target.serverUrl },
  };
}

function authenticationFailure(
  error: unknown,
  resume?: InvokeResume,
  deploymentResolution?: VercelDeploymentResolution,
): InvokeAuthenticationFailure | undefined {
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
  if (resume === undefined) {
    return code === undefined
      ? { status: "authentication-required", message }
      : { status: "authentication-required", code, message };
  }
  return code === undefined
    ? { status: "authentication-required", message, resume }
    : { status: "authentication-required", code, message, resume };
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
